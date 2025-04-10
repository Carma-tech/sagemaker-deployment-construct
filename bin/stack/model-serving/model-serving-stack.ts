// bin/stack/model-serving/model-serving-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cr from 'aws-cdk-lib/custom-resources';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { SageMakerDeploymentConstruct } from '../../../lib/sagemaker-deployment-construct';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

interface ModelProps {
  modelName: string;
  role: iam.IRole;
  modelBucketName: string;
  modelS3Key: string;
  modelDockerImage: string;
  modelServerWorkers: string;
}

interface VariantConfigProps {
  variantName: string;
  variantWeight: number;
  modelName: string;
  instanceCount?: number;
  instanceType?: string;
  serverlessConfig?: sagemaker.CfnEndpointConfig.ServerlessConfigProperty;
}

interface EndpointConfigProps {
  endpointConfigName: string;
  role: iam.IRole;
  variantConfigPropsList: VariantConfigProps[];
  asyncInferenceConfig?: sagemaker.CfnEndpointConfig.AsyncInferenceConfigProperty;
}

interface EndpointProps {
  endpointName: string;
  endpointConfigName: string;
}

export class ModelServingStack extends BaseStack {
  public sagemakerModels: Map<string, sagemaker.CfnModel> = new Map();
  public sagemakerEndpointConfig: sagemaker.CfnEndpointConfig;
  public sagemakerEndpoint: sagemaker.CfnEndpoint;
  public sagemakerExecutionRole: iam.Role;
  public sagemakerDeploymentConstruct: SageMakerDeploymentConstruct;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);

    const dynamicConfig = this.commonProps.appConfig.DynamicConfig;

    // Import the Lambda execution role from AppConfig stack
    const lambdaRoleArn = cdk.Fn.importValue('LambdaExecutionAppconfigRoleArn');
    const lambdaRole = iam.Role.fromRoleArn(this, 'ImportedLambdaRole', lambdaRoleArn);

    // Import appconfig fetcher lambda from appconfig stack
    const appConfigParameterFetcher = lambda.Function.fromFunctionAttributes(this,
      'AppconfigParameterFetcherRole',
      {
        functionArn: cdk.Fn.importValue('AppconfigParameterFetcher'),
        sameEnvironment: true,
        skipPermissions: true // Add this to prevent permission modifications
      }
    );
    
    // Create a custom resource provider
    const provider = new cr.Provider(this, 'AppConfigParameterProvider', {
      onEventHandler: appConfigParameterFetcher,
      role: lambdaRole
    });

    // Get the model artifact bucket name from AppConfig
    const dynamicBucketResource = new cdk.CustomResource(this, 'ModelArtifactBucketParameter', {
      serviceToken: provider.serviceToken,
      properties: {
        ApplicationId: dynamicConfig.ApplicationId,
        EnvironmentId: dynamicConfig.EnvironmentId,
        ConfigurationProfileId: dynamicConfig.ConfigurationProfileId,
        RequiredMinimumPollIntervalInSeconds: '30', // Keep as string
        ParameterKey: 'modelArtifactBucketName'
      },
    });
    const modelBucketName = dynamicBucketResource.getAttString('ParameterValue');
    const modelBucket = s3.Bucket.fromBucketName(this, 'ModelBucket', modelBucketName);

    // Create notification topic for alarms if emails are specified
    let alarmTopic: sns.Topic | undefined;
    if (stackConfig.SubscriptionEmails && stackConfig.SubscriptionEmails.length > 0) {
      alarmTopic = new sns.Topic(this, 'ModelAlarmTopic', {
        displayName: `${this.projectPrefix}-ModelAlarmTopic`,
        topicName: `${this.projectPrefix}-ModelAlarmTopic`,
      });
      
      // Subscribe email addresses to the topic
      stackConfig.SubscriptionEmails.forEach((email: string) => {
        if (alarmTopic) {
          alarmTopic.addSubscription(new subscriptions.EmailSubscription(email));
        }
      });
    }

    // Use the new SageMakerDeploymentConstruct
    this.sagemakerDeploymentConstruct = new SageMakerDeploymentConstruct(this, 'SageMakerDeployment', {
      prefix: this.projectPrefix,
      modelArtifactBucket: modelBucket,
      appConfigApplicationId: dynamicConfig.ApplicationId,
      appConfigEnvironmentId: dynamicConfig.EnvironmentId,
      appConfigConfigurationProfileId: dynamicConfig.ConfigurationProfileId,
      appConfigFetcherFunction: appConfigParameterFetcher,
      appConfigFetcherRole: lambdaRole,
      singleEndpointWithVariants: stackConfig.SingleEndpointWithVariants || false,
      enableModelMonitoring: stackConfig.EnableModelMonitoring !== false,
      alertEmails: stackConfig.SubscriptionEmails,
      tags: {
        Project: this.projectPrefix,
        Environment: dynamicConfig.EnvironmentId,
      },
    });

    // Store references to resources for backward compatibility
    this.sagemakerExecutionRole = this.sagemakerDeploymentConstruct.executionRole;
    
    if (this.sagemakerDeploymentConstruct.endpoint) {
      this.sagemakerEndpoint = this.sagemakerDeploymentConstruct.endpoint;
    }
    
    if (this.sagemakerDeploymentConstruct.endpointConfig) {
      this.sagemakerEndpointConfig = this.sagemakerDeploymentConstruct.endpointConfig;
    }
    
    // Convert models array to a map for backward compatibility
    if (this.sagemakerDeploymentConstruct.models) {
      this.sagemakerDeploymentConstruct.models.forEach(model => {
        // Extract model name from ARN or resource ID
        const modelName = model.modelName || model.node.id;
        this.sagemakerModels.set(modelName, model);
      });
    }

    // Output the SageMaker endpoint name
    const endpointName = this.sagemakerDeploymentConstruct.endpoint ? 
      this.sagemakerDeploymentConstruct.endpoint.attrEndpointName : '';
    
    new cdk.CfnOutput(this, 'SageMakerEndpointName', {
      value: endpointName,
      description: 'SageMaker Endpoint Name',
      exportName: `${this.projectPrefix}-sagemaker-endpoint-name`
    });
    
    // Output the SageMaker execution role ARN
    new cdk.CfnOutput(this, 'SageMakerExecutionRoleArn', {
      value: this.sagemakerExecutionRole.roleArn,
      description: 'ARN of the SageMaker execution role',
      exportName: `${this.projectPrefix}-sagemaker-execution-role-arn`
    });
  }
}
