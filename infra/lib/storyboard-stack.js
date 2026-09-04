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
const GPU_AZS = ['ap-northeast-2a', 'ap-northeast-2b']
const MODEL = 'chroma'
// CloudFront 오리진 대역 프리픽스 리스트. 리전마다 ID 가 다르다 —
// aws ec2 describe-managed-prefix-lists --region ap-northeast-2 \
//   --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
const CF_ORIGINS = 'pl-22a6434b'
const NEPTUNE_VERSION = '1.3.4.0'
const NEPTUNE_PORT = 8182
// 데모용 기본 인스턴스 클래스. --context neptuneInstance=db.r6g.large 로 덮어쓴다
const NEPTUNE_INSTANCE_DEFAULT = 'db.t4g.medium'

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
    // 모델 ARN 의 리전은 와일드카드로 둔다 — graph/index.js 가 전역 프로필을 쓰므로
    // 목적지 리전이 전 세계다. 여기를 ap-northeast-2 로 좁히면 호출이 막힌다.
    // 프로필 ARN 은 소스 리전, 즉 이 스택의 리전이다.
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
    new CfnOutput(this, 'HistoryTable', { value: history.tableName })
    new CfnOutput(this, 'GraphFnArn', { value: graphFn.functionArn })
  }
}

module.exports = { StoryboardStack }
