const fs = require('node:fs')
const path = require('node:path')
const {
  Stack, Duration, RemovalPolicy, CfnOutput,
  aws_appsync: appsync,
  aws_elasticloadbalancingv2: elb,
  aws_elasticloadbalancingv2_targets: elbtargets,
  aws_cloudfront: cloudfront,
  aws_cloudfront_origins: origins,
  aws_cognito: cognito,
  aws_dynamodb: dynamodb,
  aws_ec2: ec2,
  aws_iam: iam,
  aws_s3: s3,
  aws_s3_assets: s3assets,
  aws_s3_deployment: s3deploy,
  aws_scheduler: scheduler,
  aws_scheduler_targets: schedtargets,
} = require('aws-cdk-lib')

const HERE = __dirname
const DEMO = path.join(HERE, '..', '..', 'demo')
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8')

const GPU_TYPE = 'g6e.2xlarge'
const GPU_AZS = ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d']
const MODEL = 'chroma'
const CF_ORIGINS = 'pl-3b927c52'

/*
 * 업무 시간에만 GPU 를 켠다. 시간은 UTC 다 — 여기서 틀리면 새벽에 켜지고 낮에 꺼진다.
 * 아래는 한국 시간(KST = UTC+9) 기준 평일 09:00 켜고 20:00 끈다.
 * 다른 표준시로 옮기려면 두 숫자를 같이 고쳐야 한다.
 *
 * 유휴 감지가 아니라 스케줄이다. 아침 9시에 아무도 쓰지 않아도 켜져 있다.
 * 「쓸 때만 켜진다」가 아니라 「업무 시간에만 켜진다」가 이 설정의 정확한 설명이다.
 */
const GPU_HOURS = { up: '0 0 ? * MON-FRI *', down: '0 11 ? * MON-FRI *' }

class StoryboardStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'Ops', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: `${id}-users`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      signInCaseSensitive: false,
      standardAttributes: { fullname: { required: true, mutable: true } },
      customAttributes: { role: new cognito.StringAttribute({ mutable: true, maxLen: 20 }) },
      passwordPolicy: { minLength: 8, requireLowercase: true, requireDigits: true, requireUppercase: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const client = pool.addClient('Web', {
      userPoolClientName: 'web',
      authFlows: { userPassword: true, userSrp: true },
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(8),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
    })

    const api = new appsync.GraphqlApi(this, 'Api', {
      name: `${id}-ops`,
      definition: appsync.Definition.fromFile(path.join(HERE, '..', 'schema.graphql')),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool: pool, defaultAction: appsync.UserPoolDefaultAction.ALLOW },
        },
      },
    })

    const ops = api.addDynamoDbDataSource('OpsDs', table)
    const bus = api.addNoneDataSource('PubSubDs')

    const bedrock = api.addHttpDataSource('BedrockDs',
      `https://bedrock-runtime.${this.region}.amazonaws.com`, {
        authorizationConfig: { signingRegion: this.region, signingServiceName: 'bedrock' },
      })
    bedrock.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }))

    const js = (ds, name, typeName, fieldName, file) =>
      ds.createResolver(name, {
        typeName,
        fieldName,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromInline(read('resolvers', file)),
      })

    js(ops, 'PutOp', 'Mutation', 'publishOp', 'putOp.js')
    js(ops, 'ListOps', 'Query', 'listOps', 'listOps.js')
    js(bus, 'Presence', 'Mutation', 'publishPresence', 'presence.js')
    js(bedrock, 'Plan', 'Query', 'plan', 'plan.js')

    const realtimeUrl = api.node.defaultChild.attrRealtimeUrl

    const images = new s3.Bucket(this, 'Images', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    })

    const net = ec2.Vpc.fromLookup(this, 'Net', { isDefault: true })

    const sg = new ec2.SecurityGroup(this, 'GpuSg', { vpc: net, description: 'storyboard gpu' })

    const gpuRole = new iam.Role(this, 'GpuRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })
    images.grantPut(gpuRole)
    gpuRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }))

    const serverPy = new s3assets.Asset(this, 'GpuServer', { path: path.join(HERE, '..', 'gpu', 'server.py') })
    serverPy.grantRead(gpuRole)

    const userData = read('gpu', 'user-data.sh')
      .replace('__SERVER_URI__', serverPy.s3ObjectUrl)
      .replace('__REGION__', this.region)
      .replace('__BUCKET__', images.bucketName)
      .replace('__POOL__', pool.userPoolId)
      .replace('__CLIENT__', client.userPoolClientId)
      .replace('__MODEL__', MODEL)

    /*
     * GPU 한 대. ASG 가 아니라 단일 인스턴스다.
     *
     * ASG 로는 「껐다 켜도 가중치가 남는다」가 성립하지 않는다. ASG 는 스케일인할 때
     * 인스턴스를 *종료*하고 새로 만든다. deleteOnTermination: false 를 걸면 볼륨이
     * 지워지지 않는 대신 아무것에도 붙지 않은 채 남아서 계속 과금되고, 다음에 뜨는
     * 인스턴스는 그 볼륨을 쓰지 못해 빈 디스크로 처음부터 받는다. 고아 볼륨만 늘어난다.
     *
     * stop/start 는 볼륨을 그대로 둔 채 인스턴스만 멈춘다. 멈춘 동안 인스턴스
     * 요금($2.24/h)이 붙지 않고, 남는 것은 EBS 200GB(약 $27/월)와 ALB 뿐이다.
     */

    /*
     * 루트 볼륨만 담은 시작 템플릿. 인스턴스 설정을 여기로 옮기려는 게 아니다.
     *
     * CloudFormation 의 AWS::EC2::Instance 는 EBS 처리량(Throughput)을 받지 않는다.
     * 인스턴스에 직접 적으면 조용히 빠지고 gp3 기본값 125MB/s 가 된다 — 26GB 모델을
     * 올리는 데 3분 반이다. 시작 템플릿의 블록 디바이스는 처리량을 받으므로,
     * 볼륨 한 줄만 템플릿에 두고 인스턴스가 그것을 참조한다.
     * 500MB/s 는 server.py 의 DISK_MBS=300 이 기대하는 값이다(약 88초).
     */
    const lt = new ec2.LaunchTemplate(this, 'GpuLt', {
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(200, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          throughput: 500,
          // 껐다 켜도 모델 가중치(약 67GB)가 살아 있어야 한다. 인스턴스와 함께 지우면
          // 다음 날 아침에 다시 받는다 — 스케줄로 아낀 시간을 다운로드로 되돌려주는 셈이다.
          //
          // 대가: cdk destroy 로 인스턴스가 사라져도 이 볼륨은 남는다. 아무것에도
          // 붙지 않은 채 월 $27 이 계속 붙으므로 스택을 지운 뒤 볼륨도 지워야 한다.
          deleteOnTermination: false,
        }),
      }],
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    })

    const gpu = new ec2.Instance(this, 'Gpu', {
      vpc: net,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [GPU_AZS[0]] },
      instanceType: new ec2.InstanceType(GPU_TYPE),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id',
        { os: ec2.OperatingSystemType.LINUX },
      ),
      securityGroup: sg,
      role: gpuRole,
      userData: ec2.UserData.custom(userData),
      // user-data 는 부팅마다 돌지 않는다. 두 번째 start 에서 이것이 바뀌면
      // 인스턴스를 교체해버리므로(=볼륨을 잃는다) 명시적으로 끈다.
      userDataCausesReplacement: false,
      // requireImdsv2 를 쓰면 CDK 가 시작 템플릿을 하나 더 만들어 붙인다. 인스턴스에는
      // 템플릿을 하나만 붙일 수 있어서 위의 볼륨 템플릿과 부딪힌다. 같은 효과를 직접 쓴다.
      httpTokens: ec2.HttpTokens.REQUIRED,
      associatePublicIpAddress: true,
    })
    // 인스턴스에 적은 값이 템플릿보다 우선한다. 템플릿이 채우는 것은 루트 볼륨뿐이다.
    gpu.instance.launchTemplate = {
      launchTemplateId: lt.launchTemplateId,
      version: lt.latestVersionNumber,
    }
    /*
     * 켜고 끄기. EventBridge Scheduler 가 EC2 API 를 직접 부른다 — 우리가 만든
     * Lambda 도, 붙여 쓰는 Lambda 도 없다.
     *
     * 볼륨이 남아 있으므로 아침에 켤 때 67GB 를 다시 받지 않는다. systemd 가
     * sb.service 를 올리고, 가중치는 디스크에 그대로 있어서 몇 분 안에 준비된다.
     */
    for (const [name, when, action] of [
      ['GpuOn', GPU_HOURS.up, 'startInstances'],
      ['GpuOff', GPU_HOURS.down, 'stopInstances'],
    ]) {
      new scheduler.Schedule(this, name, {
        schedule: scheduler.ScheduleExpression.expression(`cron(${when})`),
        target: new schedtargets.Universal({
          service: 'ec2',
          action,
          input: scheduler.ScheduleTargetInput.fromObject({ InstanceIds: [gpu.instanceId] }),
          policyStatements: [new iam.PolicyStatement({
            actions: [`ec2:${action === 'startInstances' ? 'StartInstances' : 'StopInstances'}`],
            resources: [Stack.of(this).formatArn({
              service: 'ec2', resource: 'instance', resourceName: gpu.instanceId,
            })],
          })],
        }),
      })
    }

    const albSg = new ec2.SecurityGroup(this, 'GpuAlbSg', { vpc: net, description: 'storyboard gpu alb' })
    albSg.addIngressRule(ec2.Peer.prefixList(CF_ORIGINS), ec2.Port.tcp(80), 'CloudFront only')
    sg.addIngressRule(albSg, ec2.Port.tcp(8000), 'from ALB only')

    const alb = new elb.ApplicationLoadBalancer(this, 'GpuAlb', {
      vpc: net,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(120),
    })
    alb.addListener('Gen', { port: 80, open: false }).addTargets('Gpu', {
      port: 8000,
      targets: [new elbtargets.InstanceTarget(gpu, 8000)],
      healthCheck: { path: '/gen/health', interval: Duration.seconds(30), healthyThresholdCount: 2 },
      deregistrationDelay: Duration.seconds(10),
    })
    const gpuHost = alb.loadBalancerDnsName

    const site = new s3.Bucket(this, 'Site', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    })

    const origin = origins.S3BucketOrigin.withOriginAccessControl(site)
    const web = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    }

    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      defaultBehavior: web,
      defaultRootObject: 'index.html',
      additionalBehaviors: {
        '/aws-config.js': { ...web, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED },
        '/img/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(images),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        '/gen*': {
          origin: new origins.HttpOrigin(gpuHost, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            readTimeout: Duration.seconds(60),
            keepaliveTimeout: Duration.seconds(60),
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    })

    const demoPw = process.env.SB_DEMO_PW
    const config = [
      'window.SB_CONFIG = {',
      `  region: '${this.region}',`,
      `  graphqlUrl: '${api.graphqlUrl}',`,
      `  realtimeUrl: '${realtimeUrl}',`,
      `  userPoolId: '${pool.userPoolId}',`,
      `  clientId: '${client.userPoolClientId}',`,
      "  genUrl: '/gen',",
      "  boardId: 'demo',",
      ...(demoPw ? [`  demoPw: ${JSON.stringify(demoPw)},`] : []),
      '}',
      '',
    ].join('\n')

    new s3deploy.BucketDeployment(this, 'Web', {
      destinationBucket: site,
      sources: [
        s3deploy.Source.asset(DEMO, { exclude: ['aws-config.js', '.DS_Store', 'test.html'] }),
        s3deploy.Source.data('aws-config.js', config),
      ],
      distribution: cdn,
      distributionPaths: ['/*'],
    })

    new CfnOutput(this, 'Url', { value: `https://${cdn.distributionDomainName}` })
    new CfnOutput(this, 'GraphqlUrl', { value: api.graphqlUrl })
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId })
    new CfnOutput(this, 'ClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'GpuInstance', { value: gpu.instanceId })
    new CfnOutput(this, 'GpuAddr', { value: alb.loadBalancerDnsName })
  }
}

module.exports = { StoryboardStack }
