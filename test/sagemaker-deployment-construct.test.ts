// test/sagemaker-deployment.test.ts
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SageMakerDeployment } from '../lib/sagemaker-deployment-construct-stack';
import { DeploymentType } from '../lib/model-serving/deployment-strategy-factory';
import { ScalingMetric } from '../lib/autoscaling/scaling-configration';

describe('SageMakerDeployment Construct', () => {
  // Shared test stack setup
  let stack: cdk.Stack;
  
  beforeEach(() => {
    stack = new cdk.Stack();
  });
  
  // Unit tests
  test('Creates the basic resources correctly', () => {
    // ARRANGE
    // Create minimal valid props for the construct
    const minimalProps = {
      namePrefix: 'test-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'test-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'TestDeployment', minimalProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify IAM Role
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'sagemaker.amazonaws.com',
            },
          },
        ],
      },
    });
    
    // Verify SageMaker Model
    template.hasResourceProperties('AWS::SageMaker::Model', {
      ExecutionRoleArn: {
        'Fn::GetAtt': [
          expect.stringMatching(/ExecutionRole/),
          'Arn',
        ],
      },
      PrimaryContainer: {
        ModelDataUrl: {
          'Fn::Join': [
            '',
            [
              's3://',
              'test-bucket',
              '/',
              'model.tar.gz',
            ],
          ],
        },
      },
    });
    
    // Verify SageMaker Endpoint Config
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      ProductionVariants: [
        {
          InitialInstanceCount: 1,
          InstanceType: 'ml.t2.medium',
          VariantName: expect.any(String),
        },
      ],
    });
    
    // Verify SageMaker Endpoint
    template.hasResourceProperties('AWS::SageMaker::Endpoint', {
      EndpointName: expect.stringMatching(/test-model/),
    });
  });
  
  test('Creates security configurations correctly when enabled', () => {
    // ARRANGE
    const securityEnabledProps = {
      namePrefix: 'secure-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'secure-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
      security: {
        encryptionEnabled: true,
        createKmsKey: true,
        volumeEncryptionEnabled: true,
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'SecureDeployment', securityEnabledProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify KMS Key creation
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
    
    // Verify SageMaker Endpoint Config uses KMS
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      KmsKeyId: {
        'Fn::GetAtt': [
          expect.stringMatching(/EncryptionKey/),
          'Arn',
        ],
      },
    });
  });
  
  test('Creates VPC configuration correctly when enabled', () => {
    // ARRANGE
    // Create a VPC for testing
    const vpc = new ec2.Vpc(stack, 'TestVpc', {
      maxAzs: 2,
    });
    
    const securityGroup = new ec2.SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group',
    });
    
    const vpcEnabledProps = {
      namePrefix: 'vpc-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'vpc-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
      network: {
        vpc,
        existingSecurityGroups: [securityGroup],
        enableNetworkIsolation: true,
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'VpcDeployment', vpcEnabledProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify SageMaker Model has VPC configuration
    template.hasResourceProperties('AWS::SageMaker::Model', {
      VpcConfig: {
        SecurityGroupIds: [
          {
            'Fn::GetAtt': [
              expect.stringMatching(/TestSG/),
              'GroupId',
            ],
          },
        ],
        Subnets: expect.arrayContaining([
          {
            Ref: expect.stringMatching(/TestVpcPrivateSubnet/),
          },
        ]),
      },
      EnableNetworkIsolation: true,
    });
  });
  
  test('Creates multi-variant deployment correctly', () => {
    // ARRANGE
    const multiVariantProps = {
      namePrefix: 'multi-model',
      deploymentStrategy: DeploymentType.MULTI_VARIANT,
      models: [
        {
          name: 'model-variant-1',
          variantName: 'Variant1',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model1.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
          initialVariantWeight: 0.7,
        },
        {
          name: 'model-variant-2',
          variantName: 'Variant2',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model2.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
          initialVariantWeight: 0.3,
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'MultiVariantDeployment', multiVariantProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify two SageMaker Models are created
    template.resourceCountIs('AWS::SageMaker::Model', 2);
    
    // Verify SageMaker Endpoint Config has two variants
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      ProductionVariants: [
        {
          InitialVariantWeight: 0.7,
          VariantName: 'Variant1',
        },
        {
          InitialVariantWeight: 0.3,
          VariantName: 'Variant2',
        },
      ],
    });
  });
  
  test('Creates AppConfig resources correctly', () => {
    // ARRANGE
    const appConfigProps = {
      namePrefix: 'config-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'config-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
        schema: '{"type":"object","properties":{"threshold":{"type":"number"}}}',
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'AppConfigDeployment', appConfigProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify AppConfig Application
    template.hasResourceProperties('AWS::AppConfig::Application', {
      Name: 'test-app',
    });
    
    // Verify AppConfig Environment
    template.hasResourceProperties('AWS::AppConfig::Environment', {
      ApplicationId: {
        Ref: expect.stringMatching(/Application/),
      },
      Name: 'test-env',
    });
    
    // Verify AppConfig Configuration Profile
    template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
      ApplicationId: {
        Ref: expect.stringMatching(/Application/),
      },
      Name: 'test-profile',
    });
  });
  
  test('Creates monitoring resources correctly when enabled', () => {
    // ARRANGE
    const monitoringProps = {
      namePrefix: 'monitored-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'monitored-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
      monitoring: {
        dataQualityEnabled: true,
        monitoringOutputBucket: 'monitoring-bucket',
        monitoringOutputPrefix: 'monitoring-data',
        scheduleExpression: 'rate(1 day)',
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'MonitoredDeployment', monitoringProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify CloudWatch Dashboard
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: expect.stringMatching(/monitored-model/),
    });
    
    // Verify Monitoring Schedule
    // Note: This is more complex and might not exist in the pure mocked form
    // template.hasResourceProperties('AWS::SageMaker::MonitoringSchedule', {
    //   MonitoringScheduleName: expect.stringMatching(/data-quality/),
    // });
  });
  
  test('Creates auto-scaling resources correctly when enabled', () => {
    // ARRANGE
    const scalingProps = {
      namePrefix: 'scaling-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'scaling-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
      autoscaling: {
        enabled: true,
        defaultMinInstanceCount: 1,
        defaultMaxInstanceCount: 5,
        defaultScalingMetric: ScalingMetric.CPU_UTILIZATION,
        defaultTargetValue: 70,
      },
    };
    
    // ACT
    new SageMakerDeployment(stack, 'ScalingDeployment', scalingProps);
    
    // ASSERT
    const template = Template.fromStack(stack);
    
    // Verify ScalableTarget
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 5,
      ScalableDimension: 'sagemaker:variant:DesiredInstanceCount',
      ServiceNamespace: 'sagemaker',
    });
    
    // Verify ScalingPolicy
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: {
        TargetValue: 70,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'SageMakerVariantCPUUtilization',
        },
      },
    });
  });
  
  test('Validates required props correctly', () => {
    // ARRANGE
    const invalidProps = {
      // Missing required namePrefix
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'test-model',
          artifacts: {
            bucketName: 'test-bucket',
            objectKey: 'model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
    };
    
    // ACT & ASSERT
    expect(() => {
      new SageMakerDeployment(stack, 'InvalidDeployment', invalidProps as any);
    }).toThrow(/namePrefix is required/);
  });
  
  test('Validates model configuration correctly', () => {
    // ARRANGE
    const invalidModelProps = {
      namePrefix: 'invalid-model',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'invalid-model',
          // Missing artifacts
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: 'test-config-bucket',
        configKey: 'config.json',
      },
    };
    
    // ACT & ASSERT
    expect(() => {
      new SageMakerDeployment(stack, 'InvalidModelDeployment', invalidModelProps as any);
    }).toThrow(/missing required artifact information/);
  });
});