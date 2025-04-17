// bin/stack/appconfig/appconfig-operational-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as logs from 'aws-cdk-lib/aws-logs';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';

export class AppConfigOperationalStack extends BaseStack {
  public readonly appConfigApplication: appconfig.CfnApplication;
  public readonly appConfigEnvironment: appconfig.CfnEnvironment;
  public readonly configurationProfile: appconfig.CfnConfigurationProfile;
  public readonly deploymentStrategy: appconfig.CfnDeploymentStrategy;
  public readonly appConfigParameterFetcher: lambda.Function;
  public readonly configSyncLambda: lambda.Function;
  public readonly lambdaRole: iam.Role;
  public readonly configBucket: s3.IBucket;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);

    // Create or import the S3 bucket for configurations
    if (stackConfig.CreateConfigBucket) {
      this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
        bucketName: stackConfig.ConfigBucketName || `${this.projectPrefix}-model-configs-${this.account}`,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        versioned: true,
      });
      
      // Deploy initial configuration files if specified
      if (stackConfig.InitialConfigPath) {
        new s3deploy.BucketDeployment(this, 'InitialConfigDeployment', {
          sources: [s3deploy.Source.asset(stackConfig.InitialConfigPath)],
          destinationBucket: this.configBucket,
          destinationKeyPrefix: 'configs',
        });
      }
    } else {
      // Import existing bucket
      this.configBucket = s3.Bucket.fromBucketName(this, 'ImportedConfigBucket', 
        stackConfig.ConfigBucketName || `${this.projectPrefix}-model-configs-${this.account}`);
    }

    // Create an AppConfig Application
    this.appConfigApplication = new appconfig.CfnApplication(this, 'AppConfigApplication', {
      name: `${this.projectPrefix}-${stackConfig.ApplicationName}`,
      description: 'Application for dynamic model parameters',
    });

    // Create an AppConfig Environment
    this.appConfigEnvironment = new appconfig.CfnEnvironment(this, 'AppConfigEnvironment', {
      applicationId: this.appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.EnvironmentName}`,
      description: 'Production environment for dynamic configurations',
    });

    // Create a Deployment Strategy
    this.deploymentStrategy = new appconfig.CfnDeploymentStrategy(this, 'DeploymentStrategy', {
      name: `${this.projectPrefix}-${stackConfig.DeploymentStrategyName}`,
      description: 'Rolling deployment strategy for dynamic configuration updates',
      deploymentDurationInMinutes: stackConfig.DeploymentDurationInMinutes || 10,
      finalBakeTimeInMinutes: 2,
      growthFactor: stackConfig.GrowthFactor || 25,
      replicateTo: 'NONE',
    });

    // Create a Configuration Profile with improved schema validation
    this.configurationProfile = new appconfig.CfnConfigurationProfile(this, 'ConfigurationProfile', {
      applicationId: this.appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.ConfigurationProfileName}`,
      locationUri: 'hosted',
      type: 'AWS.Freeform',
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
              modelArtifactBucketName: { type: 'string' },
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
                  }
                }
              }
            }
          })
        }
      ],
    });

    // Create a CloudWatch Log Group for AppConfig
    const appConfigLogGroup = new logs.LogGroup(this, 'AppConfigLogGroup', {
      logGroupName: `${this.projectPrefix}-AppConfigDeployments`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a comprehensive IAM role for Lambda functions
    this.lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // Add specific permissions for AppConfig, S3, and CloudWatch
    this.lambdaRole.addToPolicy(new iam.PolicyStatement({
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

    this.lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
      resources: ['*'],
    }));

    // Grant S3 access to the Lambda role
    this.configBucket.grantReadWrite(this.lambdaRole);

    // Create a Lambda function to fetch AppConfig parameters
    this.appConfigParameterFetcher = new lambda.Function(this, 'AppConfigParameterFetcher', {
      runtime: lambda.Runtime.PYTHON_3_13,
      code: lambda.Code.fromAsset('codes/lambda/appconfig/parameter-fetcher'),
      handler: 'handler.handler',
      architecture: lambda.Architecture.ARM_64,
      logRetention: logs.RetentionDays.ONE_WEEK,
      role: this.lambdaRole,
      environment: {
        APPLICATION_ID: this.appConfigApplication.ref,
        ENVIRONMENT_ID: this.appConfigEnvironment.ref,
        CONFIGURATION_PROFILE_ID: this.configurationProfile.ref
      }
    });

    // Create a Lambda function to sync S3 configurations with AppConfig
    this.configSyncLambda = new lambda.Function(this, 'ConfigSyncS3Lambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      code: lambda.Code.fromAsset('codes/lambda/appconfig'),
      handler: 'sync_s3_to_appconfig.handler',
      architecture: lambda.Architecture.ARM_64,
      logRetention: logs.RetentionDays.ONE_WEEK,
      timeout: cdk.Duration.seconds(300),
      role: this.lambdaRole,
      environment: {
        APPLICATION_ID: this.appConfigApplication.ref,
        ENVIRONMENT_ID: this.appConfigEnvironment.ref,
        CONFIGURATION_PROFILE_ID: this.configurationProfile.ref,
        DEPLOYMENT_STRATEGY_ID: this.deploymentStrategy.ref,
        CONFIG_BUCKET: this.configBucket.bucketName
      }
    });

    // Set up S3 event notification to trigger the sync Lambda when configs are updated
    if (stackConfig.EnableAutoSync !== false) {
      this.configBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED_PUT,
        new s3n.LambdaDestination(this.configSyncLambda),
        { prefix: 'configs/' }
      );
    }

    // Schedule periodic sync to ensure configurations are up-to-date
    if (stackConfig.EnableScheduledSync) {
      const rule = new events.Rule(this, 'ScheduledConfigSync', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(stackConfig.SyncIntervalMinutes || 30)),
        description: 'Periodically sync S3 configurations with AppConfig'
      });
      
      rule.addTarget(new targets.LambdaFunction(this.configSyncLambda, {
        event: events.RuleTargetInput.fromObject({
          bucket: this.configBucket.bucketName,
          key: 'configs/model-config.json',
          wait_for_deployment: true
        })
      }));
    }

    // Outputs
    new cdk.CfnOutput(this, 'AppconfigParameterFetcher', {
      value: this.appConfigParameterFetcher.functionArn,
      exportName: 'AppconfigParameterFetcher'
    });

    new cdk.CfnOutput(this, 'ConfigSyncLambda', {
      value: this.configSyncLambda.functionArn,
      exportName: 'ConfigSyncLambda'
    });

    new cdk.CfnOutput(this, 'LambdaExecutionAppconfigRole', {
      value: this.lambdaRole.roleArn, 
      exportName: 'LambdaExecutionAppconfigRoleArn'
    });

    new cdk.CfnOutput(this, 'AppConfigApplicationId', {
      value: this.appConfigApplication.ref,
      description: 'The ID of the AppConfig Application',
      exportName: 'AppConfigApplicationId'
    });

    new cdk.CfnOutput(this, 'AppConfigEnvironmentId', {
      value: this.appConfigEnvironment.ref,
      description: 'The ID of the AppConfig Environment',
      exportName: 'AppConfigEnvironmentId'
    });

    new cdk.CfnOutput(this, 'ConfigurationProfileId', {
      value: this.configurationProfile.ref,
      description: 'The ID of the AppConfig Configuration Profile',
      exportName: 'ConfigurationProfileId'
    });

    new cdk.CfnOutput(this, 'DeploymentStrategyId', {
      value: this.deploymentStrategy.ref,
      description: 'The ID of the AppConfig Deployment Strategy',
      exportName: 'DeploymentStrategyId'
    });

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.configBucket.bucketName,
      description: 'The name of the S3 bucket for model configurations',
      exportName: 'ModelConfigBucketName'
    });

    // Trigger initial configuration upload during deployment
    const initialConfigUpload = new cr.AwsCustomResource(this, 'InitialConfigUpload', {
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: this.configSyncLambda.functionName,
          Payload: JSON.stringify({
            bucket: this.configBucket.bucketName,
            key: 'configs/model-config.json',
            wait_for_deployment: true
          })
        },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString())
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.configSyncLambda.functionArn]
      })
    });
    
    // Make sure the initial config upload happens after the bucket deployment
    if (stackConfig.InitialConfigPath) {
      // Find the BucketDeployment resource
      const bucketDeployment = this.node.findChild('InitialConfigDeployment') as s3deploy.BucketDeployment;
      initialConfigUpload.node.addDependency(bucketDeployment);
    }
  }
}



