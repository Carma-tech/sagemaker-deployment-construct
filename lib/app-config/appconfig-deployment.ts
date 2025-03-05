// lib/appconfig-deployment-manager.ts
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';


export interface AppConfigDeploymentProps {
  readonly application: appconfig.CfnApplication;
  readonly environment: appconfig.CfnEnvironment;
  readonly configurationProfile: appconfig.CfnConfigurationProfile;
  readonly deploymentStrategy: appconfig.CfnDeploymentStrategy;
  readonly configurationBucket: s3.IBucket;
  readonly configurationKey: string;
}

export class AppConfigDeploymentManager extends Construct {
  constructor(scope: Construct, id: string, props: AppConfigDeploymentProps) {
    super(scope, id);
    
    // Create custom resource to manage deployments
    const deploymentFunction = this.createDeploymentFunction();
    
    // Create a custom resource provider
    const provider = new cr.Provider(this, 'DeploymentProvider', {
      onEventHandler: deploymentFunction,
    });
    
    // Create custom resource for initial deployment
    new cr.AwsCustomResource(this, 'InitialDeployment', {
      onCreate: {
        service: 'AppConfig',
        action: 'startDeployment',
        parameters: {
          ApplicationId: props.application.ref,
          EnvironmentId: props.environment.ref,
          ConfigurationProfileId: props.configurationProfile.ref,
          DeploymentStrategyId: props.deploymentStrategy.ref,
          ConfigurationVersion: Date.now().toString(), // Use timestamp as version
          Description: 'Deployment from CDK construct',
        },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
  }
  
  private createDeploymentFunction(): lambda.Function {
    // Create Lambda function for deployment custom resource
    const deploymentFunction = new lambda.Function(this, 'DeploymentFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const appconfig = new AWS.AppConfig();
        const s3 = new AWS.S3();
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          // Extract properties
          const props = event.ResourceProperties;
          const {
            ApplicationId,
            EnvironmentId,
            ConfigurationProfileId,
            DeploymentStrategyId,
            ConfigBucket,
            ConfigKey,
          } = props;
          
          try {
            if (event.RequestType === 'Create' || event.RequestType === 'Update') {
              // Get configuration content from S3
              const s3Response = await s3.getObject({
                Bucket: ConfigBucket,
                Key: ConfigKey,
              }).promise();
              
              const configContent = s3Response.Body.toString('utf-8');
              
              // Start the deployment
              const deploymentResponse = await appconfig.startDeployment({
                ApplicationId,
                EnvironmentId,
                ConfigurationProfileId,
                DeploymentStrategyId,
                ConfigurationVersion: Date.now().toString(), // Use timestamp as version
                Description: 'Deployment from CDK construct',
              }).promise();
              
              console.log('Deployment created:', deploymentResponse);
              
              return {
                PhysicalResourceId: deploymentResponse.DeploymentNumber.toString(),
                Data: {
                  DeploymentId: deploymentResponse.DeploymentNumber,
                },
              };
            }
            
            if (event.RequestType === 'Delete') {
              // No need to do anything specific on delete
              // AppConfig resources will be deleted by CloudFormation
              return { PhysicalResourceId: event.PhysicalResourceId };
            }
            
            return { PhysicalResourceId: event.PhysicalResourceId || 'default' };
          } catch (error) {
            console.error('Error:', error);
            throw error;
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
      description: 'Custom resource to manage AppConfig deployments',
    });
    
    // Add necessary permissions
    deploymentFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:StartDeployment',
        'appconfig:GetDeployment',
        'appconfig:ListDeployments',
      ],
      resources: ['*'],
    }));
    
    deploymentFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject',
      ],
      resources: ['arn:aws:s3:::*/*'],
    }));
    
    return deploymentFunction;
  }
}