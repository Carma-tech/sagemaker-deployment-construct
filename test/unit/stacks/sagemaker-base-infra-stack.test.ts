import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BaseStack } from '../../../lib/base/base-stack';
import { SageMakerBaseInfraStack } from '../../../bin/stack/base/sagemaker-base-infra-stack';

describe('SageMakerBaseInfraStack', () => {
  let app: cdk.App;
  let stack: SageMakerBaseInfraStack;
  let template: Template;
  
  beforeEach(() => {
    // Create a new CDK app for each test
    app = new cdk.App();
    
    // Create stack with test properties
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
    
    // Create the stack
    stack = new SageMakerBaseInfraStack(app, props, {
      Name: 'test-base-infra',
      EnableEncryption: true,
      EnableVersioning: true
    });
    
    // Generate CloudFormation template
    template = Template.fromStack(stack);
  });
  
  test('creates a KMS key', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      Description: Match.stringLikeRegexp('KMS key for SageMaker resources encryption')
    });
  });
  
  test('creates S3 buckets with proper configuration', () => {
    // Check model artifact bucket
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('test-sagemaker-model-artifacts'),
      VersioningConfiguration: {
        Status: 'Enabled'
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
    
    // Check config bucket
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('test-sagemaker-configs'),
      VersioningConfiguration: {
        Status: 'Enabled'
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
  });
  
  test('creates SageMaker base IAM role with required permissions', () => {
    // Check base role creation
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('test-sagemaker-sagemaker-base-role'),
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'sagemaker.amazonaws.com'
            }
          }
        ]
      }
    });
    
    // Check that the role has a managed policy attached
    template.hasResource('AWS::IAM::Role', {
      Properties: {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp('AmazonSageMakerFullAccess')
              ])
            ])
          })
        ])
      }
    });
    
    // Check S3 permissions policy
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: [
              's3:GetObject',
              's3:PutObject',
              's3:ListBucket'
            ],
            Effect: 'Allow',
            Resource: Match.anyValue()
          }
        ])
      }
    });
  });
  
  test('outputs resources for cross-stack references', () => {
    template.hasOutput('ModelArtifactBucketName', {});
    template.hasOutput('ConfigBucketName', {});
    template.hasOutput('SageMakerBaseRoleArn', {});
  });
});
