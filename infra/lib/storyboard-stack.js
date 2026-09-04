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
  aws_lambda: lambda,
  aws_neptune: neptune,
  aws_s3: s3,
  aws_s3_assets: s3assets,
  aws_s3_deployment: s3deploy,
  aws_scheduler: scheduler,
  aws_scheduler_targets: schedtargets,
} = require('aws-cdk-lib')

const HERE = __dirname
const DEMO = path.join(HERE, '..', '..', 'demo')
const GRAPH_FN = path.join(HERE, '..', 'graph')
const KEYVISUAL = path.join(HERE, '..', '..', 'key-visual')
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8')

const GPU_TYPE = 'g6e.2xlarge'
// GPU_AZS[0] 이 실제로 쓰이는 AZ 다. g6e 는 AZ 마다 용량이 따로 있고 자주 마른다 —
// us-east-1 도 us-west-2 도 네 AZ 전부 InsufficientInstanceCapacity 로 막혔다.
// 또 마르면 앞의 항목을 뒤로 돌리면 된다.
//
// 리전을 옮길 때 g6e 가 그 리전에 *판매되는지*부터 확인해야 한다:
//   aws ec2 describe-instance-types --region <r> --instance-types g6e.2xlarge
// ap-southeast-1(싱가폴)에는 아예 없다(T4/T4g/A100 만 있다).
// run-instances --dry-run 으로는 확인할 수 없다 — 리전에 없는 타입에도
// "성공했을 것"이라고 답한다. 문법만 검사하며 가용성도 용량도 보지 않는다.
const GPU_AZS = ['ap-northeast-2a', 'ap-northeast-2b']
const MODEL = 'chroma'
const NEPTUNE_VERSION = '1.3.4.0'
const NEPTUNE_PORT = 8182
// 데모용 기본 인스턴스 클래스. --context neptuneInstance=db.r6g.large 로 덮어쓴다
const NEPTUNE_INSTANCE_DEFAULT = 'db.t4g.medium'
// CloudFront origin-facing 프리픽스 리스트. 리전마다 ID 가 다르다 —
// ap-northeast-2 는 pl-22a6434b, us-west-2 는 pl-82a045eb, us-east-1 은 pl-3b927c52 였다.
const CF_ORIGINS = 'pl-22a6434b'

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

    // 프로젝트별 기획 이력. Ops 와 달리 TTL 이 없다 — 영구 보관이다.
    // GraphFn 이 읽고 쓴다 (HISTORY_TABLE).
    const history = new dynamodb.Table(this, 'StoryHistory', {
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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
    // plan 결과는 GraphFn 이 Ops 테이블에 적어 둔 것을 읽어 온다
    js(ops, 'PlanResult', 'Query', 'planResult', 'planResult.js')
    // plan 자체는 GraphFn 이 받는다 — 데이터소스는 graphDs 를 만든 뒤에 붙인다.
    // Bedrock 을 치던 HTTP 데이터소스(BedrockDs)는 지웠다.

    const realtimeUrl = api.node.defaultChild.attrRealtimeUrl

    const images = new s3.Bucket(this, 'Images', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    })

    const net = ec2.Vpc.fromLookup(this, 'Net', { isDefault: true })

    // ── 관계 그래프 (Neptune Provisioned) ────────────────────────────────────
    // 브라우저의 graph-engine.js 가 조회를 들고 있고, 사실은 여기에 남는다.
    // 기본 VPC 를 그대로 쓴다 — 서브넷 그룹은 AZ 두 곳 이상이 필요하다.
    //
    // Provisioned 라서 시간당 요금이 붙는다. 쓰지 않는 동안에는 클러스터를 세워라 —
    // scripts/stop.sh / scripts/start.sh. 인스턴스 클래스는 컨텍스트로 바꿀 수 있다:
    //   npx cdk deploy --context neptuneInstance=db.r6g.large
    const slug = id.toLowerCase()
    const NEPTUNE_INSTANCE = this.node.tryGetContext('neptuneInstance') || NEPTUNE_INSTANCE_DEFAULT

    const neptuneSubnets = new neptune.CfnDBSubnetGroup(this, 'GraphSubnets', {
      dbSubnetGroupDescription: 'storyboard graph',
      dbSubnetGroupName: `${slug}-graph-subnets`,
      subnetIds: net.publicSubnets.map((s) => s.subnetId),
    })

    const neptuneSg = new ec2.SecurityGroup(this, 'NeptuneSg', { vpc: net, description: 'storyboard neptune' })

    const graph = new neptune.CfnDBCluster(this, 'Graph', {
      dbClusterIdentifier: `${slug}-graph`,
      engineVersion: NEPTUNE_VERSION,
      vpcSecurityGroupIds: [neptuneSg.securityGroupId],
      dbSubnetGroupName: neptuneSubnets.dbSubnetGroupName,
      iamAuthEnabled: false, // 데모용. 프로덕션에서는 켜고 Lambda 에 SigV4 서명을 붙인다
      storageEncrypted: true,
      deletionProtection: false,
    })
    graph.node.addDependency(neptuneSubnets)
    graph.applyRemovalPolicy(RemovalPolicy.DESTROY)

    // 클러스터에는 인스턴스가 최소 한 대 있어야 한다 (쓰기 노드)
    const graphInstance = new neptune.CfnDBInstance(this, 'GraphInstance', {
      dbClusterIdentifier: graph.dbClusterIdentifier,
      dbInstanceClass: NEPTUNE_INSTANCE,
      dbInstanceIdentifier: `${slug}-graph-instance`,
    })
    graphInstance.node.addDependency(graph)
    graphInstance.applyRemovalPolicy(RemovalPolicy.DESTROY)

    // Gremlin 과 Bedrock 을 도는 Lambda. 이 스택의 첫 Lambda 다.
    // 기본 VPC 에는 Private 서브넷이 없으므로 Public 에 넣는다 — Lambda ENI 는 퍼블릭 IP 를
    // 받지 못해서 NAT 없이는 인터넷으로 나가지 못한다. 같은 VPC 안의 Neptune 은 닿는다.
    const graphFnSg = new ec2.SecurityGroup(this, 'GraphFnSg', { vpc: net, description: 'storyboard graph lambda' })
    neptuneSg.addIngressRule(graphFnSg, ec2.Port.tcp(NEPTUNE_PORT), 'Lambda to Neptune')

    // 그래서 Bedrock 은 인터페이스 엔드포인트로 닿는다. 이게 없으면 plan 오퍼레이션이
    // 응답 없이 Lambda 타임아웃까지 매달린다 — NAT 게이트웨이보다 싸다.
    // privateDnsEnabled(기본값)라 SDK 는 평소 호스트명을 그대로 쓴다.
    const bedrockEp = net.addInterfaceEndpoint('BedrockEp', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      open: false, // VPC 전체가 아니라 이 Lambda 만 들여보낸다
    })
    bedrockEp.connections.allowFrom(graphFnSg, ec2.Port.tcp(443), 'Lambda to Bedrock')

    // plan 결과를 Ops 테이블에 적어야 한다. DynamoDB 는 게이트웨이 엔드포인트라
    // ENI 도 시간당 요금도 없다 — 라우트 테이블에 프리픽스만 얹는다.
    net.addGatewayEndpoint('DdbEp', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB })

    for (const dep of ['gremlin', '@aws-sdk/client-bedrock-runtime']) {
      if (fs.existsSync(path.join(GRAPH_FN, 'node_modules', ...dep.split('/')))) continue
      throw new Error(`infra/graph 의 의존성(${dep})이 없다. \`cd infra/graph && npm install\` 을 먼저 돌려라 — CDK 는 이 디렉터리를 그대로 올린다.`)
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
      // Neptune 조회는 초 단위로 끝난다. 길게 잡는 것은 plan(Bedrock) 때문이다 —
      // 느린 모델에서 대본 한 편이 1분을 넘긴다.
      timeout: Duration.seconds(120),
      // plan 은 Event(비동기)로 들어온다. 기본값 2 로 두면 실패한 잡이 Bedrock 을
      // 세 번까지 부른다 — 핸들러도 던지지 않게 짜 두었지만 여기서 한 번 더 막는다.
      retryAttempts: 0,
      memorySize: 512,
      environment: {
        NEPTUNE_ENDPOINT: graph.attrEndpoint,
        NEPTUNE_PORT: String(NEPTUNE_PORT),
        OPS_TABLE: table.tableName,
        HISTORY_TABLE: history.tableName,
      },
    })
    graphFn.node.addDependency(graphInstance)
    // plan 결과를 적는다. 읽기는 planResult 리졸버(OpsDs)가 한다
    table.grantWriteData(graphFn)
    history.grantReadWriteData(graphFn)

    // 교차 리전 추론 프로필을 부르면 Bedrock 이 뒤에서 다른 리전의 파운데이션 모델을
    // 부른다. 그래서 프로필 ARN 과 모델 ARN 을 둘 다 열어 둔다.
    graphFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }))

    const graphDs = api.addLambdaDataSource('GraphDs', graphFn)
    js(graphDs, 'LoadGraph', 'Query', 'loadGraph', 'loadGraph.js')
    js(graphDs, 'QueryGraph', 'Query', 'queryGraph', 'queryGraph.js')
    js(graphDs, 'SaveGraph', 'Mutation', 'saveGraph', 'saveGraph.js')
    js(graphDs, 'UpdateGraph', 'Mutation', 'updateGraph', 'updateGraph.js')
    // Query 가 아니라 Mutation 이다. 리졸버가 Lambda 를 Event 로 띄우고 jobId 만 돌려준다
    js(graphDs, 'Plan', 'Mutation', 'plan', 'plan.js')

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

    /*
     * GPU 를 놓을 퍼블릭 서브넷. AZ 는 GPU_AZS 순서로 실제 있는 것을 고른다.
     *
     * availabilityZones 를 곧바로 [GPU_AZS[0]] 으로 박으면 안 된다. cdk 가 VPC 를 아직
     * 조회하지 못한 첫 합성 패스에서는 더미 VPC(AZ 가 dummy1a/dummy1b)가 오고, AZ 로
     * 걸러진 선택 결과가 비어 버린다. ec2.Instance 는 넘긴 subnetType 이 아니라 *선택
     * 결과*로 검사하므로(hasPublic = subnets.some(…)) 빈 선택은 퍼블릭이 아닌 것으로
     * 보고 "To set 'associatePublicIpAddress: true' you must select Public subnets" 로
     * 죽는다 — 조회가 끝나기 전에 죽어서 두 번째 패스로 넘어가지 못한다.
     * 리전을 옮기면 조회 캐시(cdk.context.json)가 리전별이라 반드시 이 경로를 지난다.
     */
    const publicAzs = net.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).availabilityZones
    const gpuAz = GPU_AZS.find((az) => publicAzs.includes(az))
    const gpuSubnets = gpuAz
      ? { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [gpuAz] }
      : { subnetType: ec2.SubnetType.PUBLIC }

    const gpu = new ec2.Instance(this, 'Gpu', {
      vpc: net,
      vpcSubnets: gpuSubnets,
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
      // 켜져 있으면 graph-engine.js 가 인메모리 대신 Neptune 을 사실로 쓴다
      '  hasGraph: true,',
      ...(demoPw ? [`  demoPw: ${JSON.stringify(demoPw)},`] : []),
      '}',
      '',
    ].join('\n')

    /*
     * 버킷 배치가 세 제약을 동시에 만족해야 한다.
     *   - 기존 앱은 루트에서 열린다               → demo/* 를 루트에 둔다
     *   - key-visual/index.html 은 <script src="/aws-config.js">  → config 는 루트
     *   - key-visual/keyvisual.js 는 '../demo/core.js' 를 import  → /demo/* 도 필요
     * 마지막 것 때문에 demo 를 루트에만 두면 /demo/core.js 가 403 이 되어
     * 브라우저에서 모듈 로드가 실패한다. 그래서 demo 를 루트와 /demo/ 양쪽에 올린다.
     * 최종 구조:
     *   /aws-config.js  /index.html  /core.js …  /demo/core.js …  /key-visual/index.html
     */
    const webDeploy = new s3deploy.BucketDeployment(this, 'Web', {
      destinationBucket: site,
      sources: [
        s3deploy.Source.asset(DEMO, { exclude: ['aws-config.js', '.DS_Store', 'test.html'] }),
        s3deploy.Source.data('aws-config.js', config),
      ],
      // 이 배포는 접두사가 없어서 버킷 전체를 소스와 맞춘다 — 즉 기본 prune 이
      // 다른 배포가 만든 폴더를 통째로 지운다. 두 배포의 실행 순서는 보장되지
      // 않으므로 이 예외가 없으면 배포마다 폴더가 있다 없다 한다.
      exclude: ['key-visual/*', 'demo/*'],
      distribution: cdn,
      distributionPaths: ['/*'],
    })

    // key-visual 의 '../demo/*' import 를 받아주는 사본. 루트의 것과 같은 파일이지만
    // destinationKeyPrefix 는 배포 단위로만 지정할 수 있어서 한 배포에 루트와
    // 하위 폴더를 함께 담을 수 없다 — 그래서 배포를 나눈다.
    const webDemo = new s3deploy.BucketDeployment(this, 'WebDemo', {
      destinationBucket: site,
      destinationKeyPrefix: 'demo',
      sources: [
        s3deploy.Source.asset(DEMO, { exclude: ['aws-config.js', '.DS_Store', 'test.html'] }),
      ],
      distribution: cdn,
      distributionPaths: ['/demo/*'],
    })
    webDemo.node.addDependency(webDeploy)

    // key-visual 은 별도 BucketDeployment 다. destinationKeyPrefix 는 배포 단위로만
    // 지정할 수 있어서 한 배포에 루트와 하위 폴더를 섞을 수 없다.
    const webKv = new s3deploy.BucketDeployment(this, 'WebKeyVisual', {
      destinationBucket: site,
      destinationKeyPrefix: 'key-visual',
      // .drawio 원본과 목업 PNG 는 배포에 넣지 않는다 — 문서용 파일이다.
      sources: [s3deploy.Source.asset(KEYVISUAL, { exclude: ['.DS_Store', '*.drawio', '*.drawio.png'] })],
      distribution: cdn,
      distributionPaths: ['/key-visual/*'],
    })
    // 같은 버킷에 쓰는 두 배포를 동시에 돌리지 않는다. 순서를 고정해 두면
    // 위의 exclude 와 합쳐 어느 쪽도 상대의 파일을 지우지 않는다.
    webKv.node.addDependency(webDemo)

    new CfnOutput(this, 'Url', { value: `https://${cdn.distributionDomainName}` })
    new CfnOutput(this, 'GraphqlUrl', { value: api.graphqlUrl })
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId })
    new CfnOutput(this, 'ClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'GpuInstance', { value: gpu.instanceId })
    new CfnOutput(this, 'GpuAddr', { value: alb.loadBalancerDnsName })
    new CfnOutput(this, 'NeptuneEndpoint', { value: graph.attrEndpoint })
    new CfnOutput(this, 'HistoryTable', { value: history.tableName })
    new CfnOutput(this, 'GraphFnArn', { value: graphFn.functionArn })
  }
}

module.exports = { StoryboardStack }
