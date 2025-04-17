import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { SageMakerDeploymentConstruct } from './sagemaker-deployment-construct';
import { ConfigUtils } from './utils/config-utils';
import { SecurityUtils } from './utils/security-utils';

export interface SagemakerDeploymentConstructStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g., dev, prod)
   */
  envName: string;
  
  /**
   * Project name for resource naming
   */
  projectName: string;
  
  /**
   * Whether to use a single endpoint with multiple variants
   * @default false
   */
  useSingleEndpoint?: boolean;
  
  /**
   * Email for SNS notifications
   */
  alertEmail?: string;
  
  /**
   * S3 bucket name for model artifacts (will be created if not provided)
   */
  modelArtifactBucketName?: string;
  
  /**
   * S3 bucket name for config artifacts (will be created if not provided)
   */
  configBucketName?: string;
}

export class SagemakerDeploymentConstructStack extends cdk.Stack {
  /**
   * The SageMaker deployment construct
   */
  public readonly sagemakerDeployment: SageMakerDeploymentConstruct;
  
  /**
   * The AppConfig application
   */
  public readonly appConfigApplication: appconfig.CfnApplication;
  
  /**
   * The Step Functions state machine for model deployment
   */
  public readonly modelDeploymentWorkflow: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: SagemakerDeploymentConstructStackProps) {
    super(scope, id, props);

    const prefix = `${props.projectName}-${props.envName}`;
    
    // Create or import S3 buckets
    const modelArtifactBucket = props.modelArtifactBucketName 
      ? s3.Bucket.fromBucketName(this, 'ModelArtifactBucket', props.modelArtifactBucketName)
      : new s3.Bucket(this, 'ModelArtifactBucket', {
          bucketName: `${prefix}-model-artifacts-${this.account}`,
          encryption: s3.BucketEncryption.S3_MANAGED,
          versioned: true,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        
    const configBucket = props.configBucketName
      ? s3.Bucket.fromBucketName(this, 'ConfigBucket', props.configBucketName)
      : new s3.Bucket(this, 'ConfigBucket', {
          bucketName: `${prefix}-config-artifacts-${this.account}`,
          encryption: s3.BucketEncryption.S3_MANAGED,
          versioned: true,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
    
    // Create SNS topic for alarms
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${prefix}-model-alarms`,
      displayName: `${props.projectName} Model Alarms`,
    });
    
    // Add email subscription if provided
    if (props.alertEmail) {
      new sns.Subscription(this, 'EmailSubscription', {
        topic: alarmTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alertEmail,
      });
    }
    
    // Set up AppConfig using ConfigUtils
    const appConfigSetup = ConfigUtils.setupAppConfig(this, 'AppConfig', {
      applicationName: `${prefix}-application`,
      environmentName: props.envName,
      configProfileName: `${prefix}-model-config`,
      configBucket: configBucket,
      initialConfigPath: 'appconfig/initial-config.json',
    });
    
    this.appConfigApplication = appConfigSetup.application;
    
    // Create AppConfig fetcher Lambda and roles using SecurityUtils
    const appConfigFetcherRole = SecurityUtils.createAppConfigFetcherRole(this, 'AppConfigFetcherRole', {
      prefix,
      appConfigArn: appConfigSetup.application.attrApplicationId,
      configBucketArn: configBucket.bucketArn,
    });
    
    const appConfigFetcherFunction = SecurityUtils.createAppConfigFetcherLambda(this, 'AppConfigFetcherLambda', {
      prefix,
      role: appConfigFetcherRole,
      timeout: cdk.Duration.seconds(30),
    });
    
    // Create SageMaker deployment construct
    this.sagemakerDeployment = new SageMakerDeploymentConstruct(this, 'SageMakerDeployment', {
      prefix,
      modelArtifactBucket,
      appConfigApplicationId: appConfigSetup.application.attrApplicationId,
      appConfigEnvironmentId: appConfigSetup.environment.attrEnvironmentId,
      appConfigConfigurationProfileId: appConfigSetup.configProfile.attrConfigurationProfileId,
      appConfigFetcherFunction,
      appConfigFetcherRole,
      singleEndpointWithVariants: props.useSingleEndpoint,
      enableModelMonitoring: true,
      tags: {
        Environment: props.envName,
        Project: props.projectName,
      },
    });
    
    // Create Step Functions workflow for model deployment
    this.modelDeploymentWorkflow = this.createModelDeploymentWorkflow(prefix, modelArtifactBucket);
  }
  
  /**
   * Creates a Step Functions workflow for model deployment
   */
  private createModelDeploymentWorkflow(prefix: string, modelArtifactBucket: s3.IBucket): sfn.StateMachine {
    // Define Step Functions tasks
    
    // Task to validate the model
    const validateModel = new sfn_tasks.LambdaInvoke(this, 'ValidateModelTask', {
      lambdaFunction: new lambda.Function(this, 'ValidateModelFunction', {
        functionName: `${prefix}-validate-model`,
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('codes/validate_model'),
        timeout: cdk.Duration.minutes(5),
        environment: {
          MODEL_BUCKET: modelArtifactBucket.bucketName,
        },
      }),
    });
    
    // Task to create or update SageMaker model
    const createModel = new sfn_tasks.LambdaInvoke(this, 'CreateModelTask', {
      lambdaFunction: new lambda.Function(this, 'CreateModelFunction', {
        functionName: `${prefix}-create-model`,
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('codes/create_model'),
        timeout: cdk.Duration.minutes(10),
        environment: {
          MODEL_BUCKET: modelArtifactBucket.bucketName,
        },
      }),
    });
    
    // Task to update endpoint configuration
    const updateEndpointConfig = new sfn_tasks.LambdaInvoke(this, 'UpdateEndpointConfigTask', {
      lambdaFunction: new lambda.Function(this, 'UpdateEndpointConfigFunction', {
        functionName: `${prefix}-update-endpoint-config`,
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('codes/update_endpoint_config'),
        timeout: cdk.Duration.minutes(5),
      }),
    });
    
    // Task to deploy endpoint
    const deployEndpoint = new sfn_tasks.LambdaInvoke(this, 'DeployEndpointTask', {
      lambdaFunction: new lambda.Function(this, 'DeployEndpointFunction', {
        functionName: `${prefix}-deploy-endpoint`,
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('codes/deploy_endpoint'),
        timeout: cdk.Duration.minutes(30),
      }),
    });
    
    // Define workflow
    const definition = validateModel
      .next(createModel)
      .next(updateEndpointConfig)
      .next(deployEndpoint);
    
    // Create state machine
    return new sfn.StateMachine(this, 'ModelDeploymentWorkflow', {
      stateMachineName: `${prefix}-model-deployment`,
      definition,
      timeout: cdk.Duration.hours(2),
    });
  }
}
