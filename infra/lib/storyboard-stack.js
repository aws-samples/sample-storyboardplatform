const fs = require('node:fs')
const path = require('node:path')
const {
  Stack, Duration, RemovalPolicy, CfnOutput,
  aws_appsync: appsync,
  aws_autoscaling: autoscaling,
  aws_elasticloadbalancingv2: elb,
  aws_cloudfront: cloudfront,
  aws_cloudfront_origins: origins,
  aws_cognito: cognito,
  aws_dynamodb: dynamodb,
  aws_ec2: ec2,
  aws_iam: iam,
  aws_lambda: lambda,
  aws_neptune: neptune,
  aws_s3: s3,
  aws_s3_assets: s3assets,
  aws_s3_deployment: s3deploy,
} = require('aws-cdk-lib')

const HERE = __dirname
const DEMO = path.join(HERE, '..', '..', 'demo')
const GRAPH_FN = path.join(HERE, '..', 'graph')
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8')

const GPU_TYPE = 'g6e.2xlarge'
const GPU_AZS = ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d']
const MODEL = 'chroma'
const CF_ORIGINS = 'pl-3b927c52'
const NEPTUNE_VERSION = '1.3.4.0'
const NEPTUNE_PORT = 8182
// 데모용 NCU 폭. 최소로 놔둬도 쓰지 않는 동안에는 거의 붙지 않는다
const NEPTUNE_NCU = { min: 1, max: 8 }

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

    // ── 관계 그래프 (Neptune Serverless) ─────────────────────────────────────
    // 브라우저의 graph-engine.js 가 조회를 들고 있고, 사실은 여기에 남는다.
    // 기본 VPC 를 그대로 쓴다 — 서브넷 그룹은 AZ 두 곳 이상이 필요하다.
    const slug = id.toLowerCase()

    const neptuneSubnets = new neptune.CfnDBSubnetGroup(this, 'GraphSubnets', {
      dbSubnetGroupDescription: 'storyboard graph',
      dbSubnetGroupName: `${slug}-graph-subnets`,
      subnetIds: net.publicSubnets.map((s) => s.subnetId),
    })

    const neptuneSg = new ec2.SecurityGroup(this, 'NeptuneSg', { vpc: net, description: 'storyboard neptune' })

    const graph = new neptune.CfnDBCluster(this, 'Graph', {
      dbClusterIdentifier: `${slug}-graph`,
      engineVersion: NEPTUNE_VERSION,
      serverlessScalingConfiguration: {
        minCapacity: NEPTUNE_NCU.min,
        maxCapacity: NEPTUNE_NCU.max,
      },
      vpcSecurityGroupIds: [neptuneSg.securityGroupId],
      dbSubnetGroupName: neptuneSubnets.dbSubnetGroupName,
      iamAuthEnabled: false, // 데모용. 프로덕션에서는 켜고 Lambda 에 SigV4 서명을 붙인다
      storageEncrypted: true,
      deletionProtection: false,
    })
    graph.node.addDependency(neptuneSubnets)
    graph.applyRemovalPolicy(RemovalPolicy.DESTROY)

    // Serverless 여도 인스턴스는 최소 한 대 있어야 한다
    const graphInstance = new neptune.CfnDBInstance(this, 'GraphInstance', {
      dbClusterIdentifier: graph.dbClusterIdentifier,
      dbInstanceClass: 'db.serverless',
      dbInstanceIdentifier: `${slug}-graph-instance`,
    })
    graphInstance.node.addDependency(graph)
    graphInstance.applyRemovalPolicy(RemovalPolicy.DESTROY)

    // Gremlin 을 도는 Lambda. 이 스택의 첫 Lambda 다.
    // 기본 VPC 에는 Private 서브넷이 없으므로 Public 에 넣는다 — 인터넷으로 나가지는
    // 못하지만(NAT 없음) 같은 VPC 안의 Neptune 은 닿는다. 이 함수는 그것만 필요하다.
    const graphFnSg = new ec2.SecurityGroup(this, 'GraphFnSg', { vpc: net, description: 'storyboard graph lambda' })
    neptuneSg.addIngressRule(graphFnSg, ec2.Port.tcp(NEPTUNE_PORT), 'Lambda to Neptune')

    if (!fs.existsSync(path.join(GRAPH_FN, 'node_modules', 'gremlin'))) {
      throw new Error('infra/graph 의 의존성이 없다. `cd infra/graph && npm install` 을 먼저 돌려라 — CDK 는 이 디렉터리를 그대로 올린다.')
    }

    const graphFn = new lambda.Function(this, 'GraphFn', {
      functionName: `${id}-graph`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(GRAPH_FN, { exclude: ['package-lock.json'] }),
      vpc: net,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      securityGroups: [graphFnSg],
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        NEPTUNE_ENDPOINT: graph.attrEndpoint,
        NEPTUNE_PORT: String(NEPTUNE_PORT),
      },
    })
    graphFn.node.addDependency(graphInstance)

    const graphDs = api.addLambdaDataSource('GraphDs', graphFn)
    js(graphDs, 'LoadGraph', 'Query', 'loadGraph', 'loadGraph.js')
    js(graphDs, 'QueryGraph', 'Query', 'queryGraph', 'queryGraph.js')
    js(graphDs, 'SaveGraph', 'Mutation', 'saveGraph', 'saveGraph.js')
    js(graphDs, 'UpdateGraph', 'Mutation', 'updateGraph', 'updateGraph.js')

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

    const lt = new ec2.LaunchTemplate(this, 'GpuLt', {
      instanceType: new ec2.InstanceType(GPU_TYPE),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id',
        { os: ec2.OperatingSystemType.LINUX },
      ),
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(200, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          throughput: 500,
          deleteOnTermination: true,
        }),
      }],
      securityGroup: sg,
      role: gpuRole,
      userData: ec2.UserData.custom(userData),
      requireImdsv2: true,
      associatePublicIpAddress: true,
    })

    const gpu = new autoscaling.AutoScalingGroup(this, 'Gpu', {
      vpc: net,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: GPU_AZS },
      launchTemplate: lt,
      minCapacity: 0,
      maxCapacity: 1,
      desiredCapacity: 1,
    })
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
      targets: [gpu],
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
      // 켜져 있으면 graph-engine.js 가 인메모리 대신 Neptune 을 사실로 쓴다
      '  hasGraph: true,',
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
    new CfnOutput(this, 'GpuAsg', { value: gpu.autoScalingGroupName })
    new CfnOutput(this, 'GpuAddr', { value: alb.loadBalancerDnsName })
    new CfnOutput(this, 'NeptuneEndpoint', { value: graph.attrEndpoint })
    new CfnOutput(this, 'GraphFnArn', { value: graphFn.functionArn })
  }
}

module.exports = { StoryboardStack }
