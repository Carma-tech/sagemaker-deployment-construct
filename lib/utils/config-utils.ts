/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Configuration schema types for AppConfig validation
 */
export interface ModelParametersSchema {
  preprocessing: Record<string, any>;
  inference: Record<string, any>;
  training: Record<string, any>;
}

export interface ModelDefinitionSchema {
  ModelName: string;
  ModelS3Key: string;
  ModelDockerImage: string;
  VariantName?: string;
  VariantWeight?: number;
  InstanceCount?: number;
  InstanceType?: string;
  ModelServerWorkers?: number;
}

export interface SageMakerConfigSchema {
  modelParameters: ModelParametersSchema;
  sageMakerEndpointName: string;
  modelList: ModelDefinitionSchema[];
}

/**
 * Utility class for working with AWS AppConfig and configuration management
 */
export class ConfigUtils {
  /**
   * Creates a schema validator for SageMaker configurations
   */
  public static createSageMakerConfigSchema(): string {
    return JSON.stringify({
      type: 'object',
      properties: {
        modelParameters: {
          type: 'object',
          properties: {
            preprocessing: { type: 'object' },
            inference: { type: 'object' },
            training: { type: 'object' }
          },
          required: ['preprocessing', 'inference']
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
      required: ['modelParameters', 'modelList', 'sageMakerEndpointName']
    });
  }

  /**
   * Sets up a full AppConfig configuration for SageMaker
   */
  public static setupAppConfig(
    scope: Construct, 
    projectPrefix: string, 
    options: {
      configBucket: s3.IBucket;
      applicationName: string;
      environmentName: string;
      configProfileName: string;
      deploymentStrategyName?: string;
      initialConfigPath?: string;
      deploymentDurationInMinutes?: number;
      growthFactor?: number;
    }
  ): {
    application: appconfig.CfnApplication;
    environment: appconfig.CfnEnvironment;
    configProfile: appconfig.CfnConfigurationProfile;
    deploymentStrategy: appconfig.CfnDeploymentStrategy;
    configFetcherFunction?: lambda.Function;
  } {
    
    // Create AppConfig Application
    const application = new appconfig.CfnApplication(scope, 'Application', {
      name: `${projectPrefix}-${options.applicationName}`,
      description: 'Application for SageMaker model configuration',
    });

    // Create AppConfig Environment
    const environment = new appconfig.CfnEnvironment(scope, 'Environment', {
      applicationId: application.ref,
      name: `${projectPrefix}-${options.environmentName}`,
      description: 'Environment for SageMaker model configuration',
    });

    // Create Deployment Strategy
    const deploymentStrategy = new appconfig.CfnDeploymentStrategy(scope, 'DeploymentStrategy', {
      name: `${projectPrefix}-${options.deploymentStrategyName || 'default-strategy'}`,
      deploymentDurationInMinutes: options.deploymentDurationInMinutes || 10,
      growthFactor: options.growthFactor || 25,
      replicateTo: 'NONE',
      description: 'Strategy for deploying SageMaker model configuration changes',
    });

    // Create Configuration Profile with schema validation
    const configProfile = new appconfig.CfnConfigurationProfile(scope, 'ConfigProfile', {
      applicationId: application.ref,
      name: `${projectPrefix}-${options.configProfileName}`,
      locationUri: 'hosted',
      validators: [
        {
          type: 'JSON_SCHEMA',
          content: ConfigUtils.createSageMakerConfigSchema()
        }
      ]
    });

    // Create Lambda function for fetching configs if initial config path is provided
    let configFetcherFunction: lambda.Function | undefined;

    if (options.initialConfigPath) {
      // Create IAM role for the Lambda function
      const lambdaRole = new iam.Role(scope, 'ConfigLambdaRole', {
        roleName: `${projectPrefix}-appconfig-lambda-role`,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });

      // Add custom policy for AppConfig and S3 access
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'appconfig:GetConfiguration',
          'appconfig:GetLatestConfiguration',
          'appconfig:StartConfigurationSession',
          'appconfig:CreateHostedConfigurationVersion',
          'appconfig:StartDeployment',
          'appconfig:GetDeployment'
        ],
        resources: [`arn:aws:appconfig:*:*:*`],
      }));

      // Grant access to S3
      options.configBucket.grantReadWrite(lambdaRole);

      // Create Lambda function for fetching AppConfig parameters
      configFetcherFunction = new lambda.Function(scope, 'ConfigFetcher', {
        runtime: lambda.Runtime.PYTHON_3_10,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset('codes/lambda/appconfig/parameter-fetcher'),
        role: lambdaRole,
        environment: {
          APPLICATION_ID: application.ref,
          ENVIRONMENT_ID: environment.ref,
          CONFIGURATION_PROFILE_ID: configProfile.ref,
          CONFIG_BUCKET: options.configBucket.bucketName,
          INITIAL_CONFIG_PATH: options.initialConfigPath
        },
        timeout: cdk.Duration.minutes(1),
      });

      // Use Lambda to initially deploy the configuration
      const deployInitialConfigFn = new lambda.Function(scope, 'DeployInitialConfig', {
        runtime: lambda.Runtime.PYTHON_3_10,
        handler: 'initial_deploy.handler',
        code: lambda.Code.fromAsset('codes/lambda/appconfig/initial-deploy'),
        role: lambdaRole,
        environment: {
          APPLICATION_ID: application.ref,
          ENVIRONMENT_ID: environment.ref,
          CONFIGURATION_PROFILE_ID: configProfile.ref,
          CONFIG_BUCKET: options.configBucket.bucketName,
          CONFIG_PATH: options.initialConfigPath,
          DEPLOYMENT_STRATEGY_ID: deploymentStrategy.ref
        },
        timeout: cdk.Duration.minutes(5),
      });

      // Deploy the initial configuration during stack creation
      const initialDeploymentResource = new cr.AwsCustomResource(scope, 'InitialConfigDeployment', {
        onCreate: {
          service: 'Lambda',
          action: 'invoke',
          parameters: {
            FunctionName: deployInitialConfigFn.functionName,
            Payload: JSON.stringify({
              requestType: 'Create',
              resourceProperties: {
                ApplicationId: application.ref,
                EnvironmentId: environment.ref,
                ConfigurationProfileId: configProfile.ref,
                DeploymentStrategyId: deploymentStrategy.ref
              }
            })
          },
          physicalResourceId: cr.PhysicalResourceId.of('InitialConfigDeployment')
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [deployInitialConfigFn.functionArn]
          })
        ])
      });

      // Ensure proper deployment order
      initialDeploymentResource.node.addDependency(application);
      initialDeploymentResource.node.addDependency(environment);
      initialDeploymentResource.node.addDependency(configProfile);
      initialDeploymentResource.node.addDependency(deploymentStrategy);
    }

    return {
      application,
      environment,
      configProfile,
      deploymentStrategy,
      configFetcherFunction
    };
  }

  /**
   * Get parameter from AppConfig configuration using a custom resource
   */
  public static getAppConfigParameter(
    scope: Construct,
    id: string,
    options: {
      applicationId: string;
      environmentId: string;
      configProfileId: string;
      parameterKey: string;
      lambdaFunction: lambda.IFunction;
      provider?: cr.Provider;
    }
  ): string {
    // Create provider if not provided
    const provider = options.provider || new cr.Provider(scope, `${id}Provider`, {
      onEventHandler: options.lambdaFunction
    });

    // Create custom resource to fetch parameter
    const parameterResource = new cdk.CustomResource(scope, id, {
      serviceToken: provider.serviceToken,
      properties: {
        ApplicationId: options.applicationId,
        EnvironmentId: options.environmentId,
        ConfigurationProfileId: options.configProfileId,
        ParameterKey: options.parameterKey,
        RequiredMinimumPollIntervalInSeconds: 30,
      },
    });

    return parameterResource.getAttString('ParameterValue');
  }
}
