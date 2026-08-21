#!/usr/bin/env node
const { App } = require('aws-cdk-lib')
const { StoryboardStack } = require('../lib/storyboard-stack')

const app = new App()
new StoryboardStack(app, 'StoryboardDemo', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
})
