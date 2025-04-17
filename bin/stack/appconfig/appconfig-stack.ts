import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface AppConfigStackProps {
  configBucket: s3.IBucket;
  encryptionKey: kms.IKey;
  applicationName: string;
  environmentName: string;
  configurationProfileName: string;
  deploymentStrategyName: string;
  deploymentDurationInMinutes?: number;
  growthFactor?: number;
  initialConfigPath?: string;
  enableAutoSync?: boolean;
  syncIntervalMinutes?: number;
  existingApplicationId?: string;
  existingEnvironmentId?: string;
  existingProfileId?: string;
  Name?: string;
}

export class AppConfigStack extends BaseStack {
  public readonly appConfigApplication: appconfig.CfnApplication;
  public readonly appConfigEnvironment: appconfig.CfnEnvironment;
  public readonly configurationProfile: appconfig.CfnConfigurationProfile;
  public readonly deploymentStrategy: appconfig.CfnDeploymentStrategy;
  public readonly configFetcher: lambda.Function;
  public readonly lambdaRole: iam.Role;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: AppConfigStackProps) {
    // Use the Name from stackConfig if provided, otherwise use a consistent naming convention
    const stackName = stackConfig.Name || `${props.projectPrefix}-appconfig`;
    super(scope, stackName, props, stackConfig);

    // Create AppConfig Application
    this.appConfigApplication = new appconfig.CfnApplication(this, 'Application', {
      name: `${this.projectPrefix}-${stackConfig.applicationName}`,
      description: 'Application for SageMaker model configuration',
    });

    // Create AppConfig Environment
    this.appConfigEnvironment = new appconfig.CfnEnvironment(this, 'Environment', {
      applicationId: this.appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.environmentName}`,
      description: 'Environment for SageMaker model configuration',
    });

    // Create Deployment Strategy
    this.deploymentStrategy = new appconfig.CfnDeploymentStrategy(this, 'DeploymentStrategy', {
      name: `${this.projectPrefix}-${stackConfig.deploymentStrategyName}`,
      deploymentDurationInMinutes: stackConfig.deploymentDurationInMinutes || 10,
      growthFactor: stackConfig.growthFactor || 25,
      replicateTo: 'NONE',
      description: 'Strategy for deploying SageMaker model configuration changes',
    });

    // Create Configuration Profile with schema validation
    this.configurationProfile = new appconfig.CfnConfigurationProfile(this, 'ConfigProfile', {
      applicationId: this.appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.configurationProfileName}`,
      locationUri: 'hosted',
      validators: [
        {
          type: 'JSON_SCHEMA',
          content: JSON.stringify({
            type: 'object',
            properties: {
              modelParameters: {
                type: 'object',
                properties: {
                  preprocessing: { type: 'object' },
                  inference: { type: 'object' },
                  training: { type: 'object' }
                }
              },
              sageMakerEndpointName: { type: 'string' },
              modelList: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ModelName: { type: 'string' },
                    ModelS3Key: { type: 'string' },
                    ModelDockerImage: { type: 'string' },
                    VariantName: { type: 'string' },
                    VariantWeight: { type: 'number' },
                    InstanceCount: { type: 'number' },
                    InstanceType: { type: 'string' },
                    ModelServerWorkers: { type: 'number' }
                  },
                  required: ['ModelName', 'ModelS3Key', 'ModelDockerImage']
                }
              }
            },
            required: ['modelParameters', 'modelList']
          })
        }
      ]
    });

    // Create Lambda role for config management
    this.lambdaRole = new iam.Role(this, 'ConfigLambdaRole', {
      roleName: `${this.projectPrefix}-appconfig-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add custom policy for AppConfig and S3 access
    this.lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appconfig:GetConfiguration',
        'appconfig:GetLatestConfiguration',
        'appconfig:StartConfigurationSession',
        'appconfig:CreateHostedConfigurationVersion',
        'appconfig:StartDeployment',
        'appconfig:GetDeployment'
      ],
      resources: [`arn:aws:appconfig:${this.region}:${this.account}:*`],
    }));

    // Grant access to S3 and KMS
    stackConfig.configBucket.grantReadWrite(this.lambdaRole);
    stackConfig.encryptionKey.grantEncryptDecrypt(this.lambdaRole);

    // Create Lambda function for fetching AppConfig parameters
    this.configFetcher = new lambda.Function(this, 'ConfigFetcher', {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('codes/lambda/appconfig/parameter-fetcher'),
      role: this.lambdaRole,
      environment: {
        APPLICATION_ID: this.appConfigApplication.ref,
        ENVIRONMENT_ID: this.appConfigEnvironment.ref,
        CONFIGURATION_PROFILE_ID: this.configurationProfile.ref
      },
      timeout: cdk.Duration.minutes(1),
    });

    // Create CloudWatch Logs group for AppConfig
    new logs.LogGroup(this, 'AppConfigLogs', {
      logGroupName: `${this.projectPrefix}-appconfig-logs`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a Custom Resource to create and deploy the initial configuration
    const initialConfigContentPath = stackConfig.initialConfigPath || 'config/model-config.json';
    let configContent = '';
    
    try {
      // Try to read the model configuration file
      configContent = fs.readFileSync(initialConfigContentPath, 'utf-8');
      console.log(`Successfully loaded initial configuration from ${initialConfigContentPath}`);
    } catch (error) {
      console.warn(`Warning: Could not load initial config from ${initialConfigContentPath}: ${error}`);
      console.warn('Will use default empty configuration');
      configContent = JSON.stringify({
        modelParameters: {
          preprocessing: {
            normalization: true
          },
          inference: {
            thresholds: {
              classification: 0.5
            }
          }
        },
        modelList: []
      });
    }

    // Create Custom Resource for creating the configuration version and deployment
    const configVersionCreator = new cr.AwsCustomResource(this, 'ConfigVersionCreator', {
      onUpdate: {
        service: 'AppConfig',
        action: 'createHostedConfigurationVersion',
        parameters: {
          ApplicationId: this.appConfigApplication.ref,
          ConfigurationProfileId: this.configurationProfile.ref,
          Content: configContent,
          ContentType: 'application/json'
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.projectPrefix}-config-version-${Date.now()}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // Create Custom Resource for deploying the configuration version
    new cr.AwsCustomResource(this, 'ConfigDeployment', {
      onUpdate: {
        service: 'AppConfig',
        action: 'startDeployment',
        parameters: {
          ApplicationId: this.appConfigApplication.ref,
          EnvironmentId: this.appConfigEnvironment.ref,
          ConfigurationProfileId: this.configurationProfile.ref,
          ConfigurationVersion: configVersionCreator.getResponseField('VersionNumber'),
          DeploymentStrategyId: this.deploymentStrategy.ref,
          Description: 'Initial configuration deployment'
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.projectPrefix}-deployment-${Date.now()}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // Export key values for other stacks
    new cdk.CfnOutput(this, 'AppConfigApplicationId', {
      value: this.appConfigApplication.ref,
      exportName: `${this.projectPrefix}-appconfig-application-id`,
    });

    new cdk.CfnOutput(this, 'AppConfigEnvironmentId', {
      value: this.appConfigEnvironment.ref,
      exportName: `${this.projectPrefix}-appconfig-environment-id`,
    });

    new cdk.CfnOutput(this, 'AppConfigProfileId', {
      value: this.configurationProfile.ref,
      exportName: `${this.projectPrefix}-appconfig-profile-id`,
    });

    new cdk.CfnOutput(this, 'ConfigFetcherArn', {
      value: this.configFetcher.functionArn,
      exportName: `${this.projectPrefix}-config-fetcher-arn`,
    });
  }
}