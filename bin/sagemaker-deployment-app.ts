#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import { StackCommonProps } from '../lib/base/base-stack';

// Import stack classes
import { SageMakerBaseInfraStack } from './stack/base/sagemaker-base-infra-stack';
import { AppConfigStack } from './stack/appconfig/appconfig-stack';
import { SageMakerModelStack } from './stack/sagemaker/sagemaker-model-stack';
import { SageMakerEndpointStack } from './stack/sagemaker/sagemaker-endpoint-stack';
import { SageMakerAsyncEndpointStack } from './stack/sagemaker/sagemaker-async-endpoint-stack';
import { SageMakerServerlessEndpointStack } from './stack/sagemaker/sagemaker-serverless-endpoint-stack';
import { MonitorDashboardStack } from './stack/monitor-dashboard/monitor-dashboard-stack';
import { WorkflowStack } from './stack/workflow/workflow-stack';
import * as sns from 'aws-cdk-lib/aws-sns';

// Load deployment configuration
function loadDeploymentConfig(configPath: string): any {
  try {
    const configBuffer = fs.readFileSync(configPath, 'utf8');
    // console.log('deployment config buffer: ', configBuffer)
    return JSON.parse(configBuffer);
  } catch (err) {
    console.error(`Error loading deployment config: ${err}`);
    throw err;
  }
}

// Load model configuration 
function loadModelConfig(configPath: string): any {
  try {
    const configBuffer = fs.readFileSync(configPath, 'utf8');
    // console.log('model config buffer: ', configBuffer)
    return JSON.parse(configBuffer);
  } catch (err) {
    console.error(`Error loading model config: ${err}`);
    throw err;
  }
}

// Main CDK app function
async function main() {
  // Load configuration
  const deploymentConfig = loadDeploymentConfig('config/deployment-config.json');
  const modelConfig = loadModelConfig('config/model-config.json');
  
  // Get target environment from command line args or default to 'dev'
  const targetEnv = process.env.DEPLOYMENT_ENV || 'dev';
  if (!deploymentConfig.environments[targetEnv]) {
    throw new Error(`Environment '${targetEnv}' not defined in deployment config`);
  }
  
  // Get environment-specific configuration
  const envConfig = deploymentConfig.environments[targetEnv];
  const projectName = deploymentConfig.project.name;
  const projectPrefix = `${projectName}-${envConfig.stage}`;
  
  console.log(`Deploying to environment: ${targetEnv}`);
  console.log(`Project prefix: ${projectPrefix}`);
  
  // Set up stack common properties
  const stackCommonProps: StackCommonProps = {
    projectPrefix: projectPrefix,
    appConfig: {
      Project: {
        Name: projectName,
        Stage: envConfig.stage,
        Account: envConfig.account,
        Region: envConfig.region
      },
      Models: modelConfig.modelList,
      AppConfig: {
        ApplicationName: `${projectName}-${envConfig.appConfigSuffix}`,
        EnvironmentName: envConfig.stage,
        ProfileName: 'sagemaker-config',
        CreateNew: envConfig.createNewAppConfig,
        ExistingAppId: envConfig.existingAppConfigAppId,
        ExistingEnvId: envConfig.existingAppConfigEnvId,
        ExistingProfileId: envConfig.existingAppConfigProfileId
      },
      Inference: {
        Type: envConfig.inferenceType || 'async', // 'realtime', 'async', 'serverless'
        AsyncConfig: envConfig.asyncConfig || {
          maxConcurrentInvocationsPerInstance: 5,
          expiresInSeconds: 3600
        },
        ServerlessConfig: envConfig.serverlessConfig || {
          memorySize: 2048,
          maxConcurrency: 5
        }
      }
    },
    env: {
      account: envConfig.account,
      region: envConfig.region,
    },
  };
  
  // Create CDK app
  const app = new cdk.App();
  
  // 1. Deploy Base Infrastructure Stack
  const baseInfraStack = new SageMakerBaseInfraStack(app, 
    stackCommonProps,
    {
      Name: `${projectPrefix}-base-infra`,
      EnableEncryption: true,
      EnableVersioning: deploymentConfig.modelArtifacts.enableVersioning
    }
  );
  
  // 2. Deploy AppConfig Stack - conditionally create new or use existing
  let appConfigStack: AppConfigStack;
  if (envConfig.createNewAppConfig) {
    // Create new AppConfig resources
    appConfigStack = new AppConfigStack(app, 
      stackCommonProps,
      {
        configBucket: baseInfraStack.configBucket,
        encryptionKey: baseInfraStack.encryptionKey,
        applicationName: stackCommonProps.appConfig.AppConfig.ApplicationName,
        environmentName: stackCommonProps.appConfig.AppConfig.EnvironmentName,
        configurationProfileName: stackCommonProps.appConfig.AppConfig.ProfileName,
        deploymentStrategyName: 'standard',
        deploymentDurationInMinutes: 5,
        growthFactor: 20,
        initialConfigPath: 'config/app-config.json',
        enableAutoSync: true
      }
    );
    appConfigStack.addDependency(baseInfraStack);
  } else {
    // Use existing AppConfig resources
    if (!envConfig.existingAppConfigAppId || !envConfig.existingAppConfigEnvId || !envConfig.existingAppConfigProfileId) {
      throw new Error('Existing AppConfig IDs must be provided when createNewAppConfig is false');
    }
    
    appConfigStack = new AppConfigStack(app, 
      stackCommonProps,
      {
        configBucket: baseInfraStack.configBucket,
        encryptionKey: baseInfraStack.encryptionKey,
        applicationName: stackCommonProps.appConfig.AppConfig.ApplicationName,
        environmentName: stackCommonProps.appConfig.AppConfig.EnvironmentName,
        configurationProfileName: stackCommonProps.appConfig.AppConfig.ProfileName,
        deploymentStrategyName: 'standard',
        existingApplicationId: envConfig.existingAppConfigAppId,
        existingEnvironmentId: envConfig.existingAppConfigEnvId,
        existingProfileId: envConfig.existingAppConfigProfileId
      }
    );
    appConfigStack.addDependency(baseInfraStack);
  }
  
  // 3. Deploy SageMaker Model Stack
  const modelStack = new SageMakerModelStack(app, 
    stackCommonProps,
    {
      Name: `${projectPrefix}-model`,
      modelArtifactBucket: baseInfraStack.modelArtifactBucket,
      baseRole: baseInfraStack.sagemakerBaseRole,
      encryptionKey: baseInfraStack.encryptionKey,
      models: modelConfig.modelList.map((model: any) => ({
        modelName: model.ModelName,
        artifactKey: model.ModelS3Key,
        image: model.ModelDockerImage,
        environment: model.Environment || {}
      }))
    }
  );
  modelStack.addDependency(baseInfraStack);
  
  // 4. Deploy SageMaker Endpoint based on inference type
  const inferenceType = stackCommonProps.appConfig.Inference.Type;
  let endpointStack: SageMakerEndpointStack | SageMakerAsyncEndpointStack | SageMakerServerlessEndpointStack;

  if (inferenceType === 'async') {
    // Create notification topic for async inference
    const notificationTopic = new sns.Topic(baseInfraStack, 'AsyncInferenceNotifications', {
      topicName: `${projectPrefix}-async-inference-notifications`,
      displayName: 'SageMaker Async Inference Notifications',
    });

    // Deploy Async Endpoint
    endpointStack = new SageMakerAsyncEndpointStack(app, 
      stackCommonProps,
      {
        Name: `${projectPrefix}-async-endpoint`,
        modelExecutionRole: modelStack.executionRole,
        models: modelStack.models,
        outputBucket: baseInfraStack.modelArtifactBucket,
        notificationTopic: notificationTopic,
        endpointConfig: modelConfig.modelList.map((model: any) => ({
          variantName: model.VariantName || `${model.ModelName}Variant`,
          modelName: model.ModelName,
          instanceType: model.InstanceType || 'ml.m5.large',
          initialInstanceCount: model.InstanceCount || 1,
          autoScaling: model.AutoScaling || {
            minCapacity: 1,
            maxCapacity: 2,
            targetInvocationsPerInstance: 5
          }
        })),
        asyncConfig: stackCommonProps.appConfig.Inference.AsyncConfig
      }
    );
  } else if (inferenceType === 'serverless') {
    // Deploy Serverless Endpoint
    endpointStack = new SageMakerServerlessEndpointStack(app, 
      stackCommonProps,
      {
        Name: `${projectPrefix}-serverless-endpoint`,
        modelExecutionRole: modelStack.executionRole,
        models: modelStack.models,
        serverlessConfig: modelConfig.modelList.map((model: any) => ({
          variantName: model.VariantName || `${model.ModelName}Variant`,
          modelName: model.ModelName,
          memorySize: model.ServerlessConfig?.memorySize || stackCommonProps.appConfig.Inference.ServerlessConfig.memorySize,
          maxConcurrency: model.ServerlessConfig?.maxConcurrency || stackCommonProps.appConfig.Inference.ServerlessConfig.maxConcurrency
        }))
      }
    );
  } else {
    // Default: Deploy Standard Realtime Endpoint
    endpointStack = new SageMakerEndpointStack(app, 
      stackCommonProps,
      {
        Name: `${projectPrefix}-endpoint`,
        modelExecutionRole: modelStack.executionRole,
        models: modelStack.models,
        endpointConfig: modelConfig.modelList.map((model: any) => ({
          variantName: model.VariantName || `${model.ModelName}Variant`,
          modelName: model.ModelName,
          instanceType: model.InstanceType || 'ml.m5.large',
          initialInstanceCount: model.InstanceCount || 1,
          autoScaling: model.AutoScaling || {
            minCapacity: 1,
            maxCapacity: 2,
            targetInvocationsPerInstance: 5
          }
        }))
      }
    );
  }
  
  endpointStack.addDependency(modelStack);
  endpointStack.addDependency(appConfigStack);
  
  // 5. Deploy Monitoring Stack (Conditional)
  if (envConfig.enableMonitoring) {
    const monitoringStack = new MonitorDashboardStack(app, 
      stackCommonProps,
      {
        Name: `${projectPrefix}-monitoring`,
        DashboardName: `${projectPrefix}-dashboard`,
        Alarms: {
          LatencyThresholdMs: 1000,
          ErrorRateThreshold: 5,
          MinInvocationsPerMinute: 1
        },
        AlarmNotifications: {
          EmailAddresses: modelConfig.operators?.emails || []
        },
        AppConfig: {
          ApplicationId: appConfigStack.appConfigApplication.ref,
          EnvironmentId: appConfigStack.appConfigEnvironment.ref,
          ConfigurationProfileId: appConfigStack.configurationProfile.ref
        }
      }
    );
    monitoringStack.addDependency(endpointStack);
  }
  
  // 6. Deploy Workflow Stack (Conditional)
  if (envConfig.enableWorkflow) {
    const workflowStack = new WorkflowStack(app, 
      stackCommonProps,
      {
        Name: `${projectPrefix}-workflow`,
        modelArtifactBucket: baseInfraStack.modelArtifactBucket,
        configBucket: baseInfraStack.configBucket,
        appConfigApplicationId: appConfigStack.appConfigApplication.ref,
        appConfigEnvironmentId: appConfigStack.appConfigEnvironment.ref,
        appConfigProfileId: appConfigStack.configurationProfile.ref,
        sagemakerExecutionRole: modelStack.executionRole,
        endpointName: `${projectPrefix}-${inferenceType === 'async' ? 'async-' : inferenceType === 'serverless' ? 'serverless-' : ''}endpoint`,
        scheduleRetraining: modelConfig.retraining?.scheduleEnabled || false,
        retrainingScheduleExpression: modelConfig.retraining?.scheduleExpression || 'cron(0 0 ? * MON *)'  // Default: weekly on Monday
      }
    );
    workflowStack.addDependency(baseInfraStack);
    workflowStack.addDependency(appConfigStack);
    workflowStack.addDependency(endpointStack);
  }
  
  app.synth();
}

main().catch(err => {
  console.error('Error deploying stacks:', err);
  process.exit(1);
});
