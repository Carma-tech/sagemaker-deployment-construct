import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SageMakerAsyncEndpointStack } from '../../../bin/stack/sagemaker/sagemaker-async-endpoint-stack';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';

describe('SageMakerAsyncEndpointStack', () => {
  let app: cdk.App;
  let stack: SageMakerAsyncEndpointStack;
  let template: Template;
  
  beforeEach(() => {
    // Create a new CDK app
    app = new cdk.App();
    
    // Create resource stack to hold resource mocks
    const resourceStack = new cdk.Stack(app, 'ResourceStack');
    
    // Create a mock role
    const role = new iam.Role(resourceStack, 'SageMakerRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      roleName: 'test-sagemaker-role'
    });
    
    // Create a mock bucket
    const bucket = new s3.Bucket(resourceStack, 'TestBucket', {
      bucketName: 'test-bucket',
      versioned: true
    });
    
    // Create a mock SNS topic
    const topic = new sns.Topic(resourceStack, 'TestTopic', {
      topicName: 'test-async-notifications'
    });
    
    // Create a mock model
    const model = new sagemaker.CfnModel(resourceStack, 'TestModel', {
      executionRoleArn: role.roleArn,
      modelName: 'test-model',
      primaryContainer: {
        image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test-image:latest',
        modelDataUrl: 's3://test-bucket/test-model.tar.gz'
      }
    });
    
    // Create a Map of models
    const modelsMap = new Map<string, sagemaker.CfnModel>();
    modelsMap.set('test-model', model);
    
    // Set up stack common props
    const props = {
      projectPrefix: 'test-sagemaker',
      appConfig: {
        Project: {
          Name: 'TestProject',
          Stage: 'test',
          Account: '123456789012',
          Region: 'us-east-1'
        }
      },
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    };
    
    // Create the actual stack we're testing
    stack = new SageMakerAsyncEndpointStack(app, props, {
      Name: 'test-async-endpoint',
      modelExecutionRole: role,
      models: modelsMap,
      outputBucket: bucket,
      notificationTopic: topic,
      endpointConfig: [
        {
          variantName: 'TestVariant',
          modelName: 'test-model',
          instanceType: 'ml.m5.large',
          initialInstanceCount: 1
        }
      ],
      asyncConfig: {
        maxConcurrentInvocationsPerInstance: 5,
        expiresInSeconds: 3600
      }
    });
    
    // Generate CloudFormation template for the stack under test
    template = Template.fromStack(stack);
  });
  
  test('creates an SQS queue for async processing', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 900 // 15 minutes
    });
  });
  
  test('creates an endpoint config with appropriate variant', () => {
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      ProductionVariants: Match.arrayWith([
        Match.objectLike({
          VariantName: 'TestVariant',
          InitialInstanceCount: 1,
          InstanceType: 'ml.m5.large'
        })
      ])
    });
  });
  
  test('creates an endpoint with appropriate endpoint config', () => {
    template.hasResourceProperties('AWS::SageMaker::Endpoint', {
      EndpointName: Match.stringLikeRegexp('test-sagemaker-async-endpoint')
    });
  });
  
  test('creates IAM policy for endpoint invocation', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: Match.stringLikeRegexp('test-sagemaker-async-invoke-policy'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sagemaker:InvokeEndpointAsync',
            Effect: 'Allow'
          })
        ])
      }
    });
  });
  
  test('exports appropriate outputs', () => {
    template.hasOutput('AsyncEndpointName', {});
    template.hasOutput('AsyncEndpointArn', {});
    template.hasOutput('AsyncInferenceQueueUrl', {});
  });
});
