// lib/appconfig-integration.ts
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface AppConfigIntegrationProps {
  readonly applicationName: string;
  readonly environmentName: string;
  readonly configurationProfileName: string;
  readonly configurationBucket: s3.IBucket;
  readonly configurationKey: string;
  readonly deploymentStrategy?: 'Immediate' | 'Standard' | 'Custom';
  readonly customDeploymentDuration?: number;
  readonly customDeploymentBakeTime?: number;
  readonly customDeploymentGrowthFactor?: number;
  readonly configurationSchema?: string;
  readonly validationRole?: iam.IRole;
}

export class AppConfigIntegration extends Construct {
  public readonly application: appconfig.CfnApplication;
  public readonly environment: appconfig.CfnEnvironment;
  public readonly configurationProfile: appconfig.CfnConfigurationProfile;
  public readonly deploymentStrategy: appconfig.CfnDeploymentStrategy;
  public readonly initialDeployment: appconfig.CfnHostedConfigurationVersion;
  public readonly validationLambda?: lambda.Function;
  
  constructor(scope: Construct, id: string, props: AppConfigIntegrationProps) {
    super(scope, id);
    
    // Create AppConfig Application
    this.application = new appconfig.CfnApplication(this, 'Application', {
      name: props.applicationName,
      description: `AppConfig application for SageMaker model configuration: ${props.applicationName}`,
    });
    
    // Create AppConfig Environment
    this.environment = new appconfig.CfnEnvironment(this, 'Environment', {
      applicationId: this.application.ref,
      name: props.environmentName,
      description: `Environment for ${props.applicationName}`,
    });
    
    // Create deployment strategy or use standard one
    this.deploymentStrategy = this.createDeploymentStrategy(props);
    
    // Create optional validation Lambda if schema is provided
    if (props.configurationSchema) {
      this.validationLambda = this.createValidationLambda(props);
    }
    
    // Create configuration profile
    this.configurationProfile = this.createConfigurationProfile(props);
  }
  
  private createDeploymentStrategy(props: AppConfigIntegrationProps): appconfig.CfnDeploymentStrategy {
    if (props.deploymentStrategy === 'Immediate') {
      return new appconfig.CfnDeploymentStrategy(this, 'ImmediateStrategy', {
        name: `${props.applicationName}-immediate`,
        deploymentDurationInMinutes: 0,
        growthFactor: 100,
        replicateTo: 'NONE',
        finalBakeTimeInMinutes: 0,
      });
    } else if (props.deploymentStrategy === 'Custom' && 
               props.customDeploymentDuration !== undefined && 
               props.customDeploymentGrowthFactor !== undefined) {
      return new appconfig.CfnDeploymentStrategy(this, 'CustomStrategy', {
        name: `${props.applicationName}-custom`,
        deploymentDurationInMinutes: props.customDeploymentDuration,
        growthFactor: props.customDeploymentGrowthFactor,
        replicateTo: 'NONE',
        finalBakeTimeInMinutes: props.customDeploymentBakeTime || 0,
      });
    } else {
      // Use standard strategy (linear deployment over 10 minutes with 10% growth increments)
      return new appconfig.CfnDeploymentStrategy(this, 'StandardStrategy', {
        name: `${props.applicationName}-standard`,
        deploymentDurationInMinutes: 10,
        growthFactor: 10,
        replicateTo: 'NONE',
        finalBakeTimeInMinutes: 5,
      });
    }
  }
  
  private createValidationLambda(props: AppConfigIntegrationProps): lambda.Function {
    // Create Lambda function for configuration validation
    const validationFunction = new lambda.Function(this, 'ValidationFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          try {
            // Parse the configuration to ensure it's valid JSON
            const configuration = JSON.parse(event.configuration);
            
            // Apply schema validation here based on the schema
            const schema = ${props.configurationSchema};
            
            // Implement schema validation logic
            // (For a production environment, you'd want to use a validation library)
            // This is a simple example that just ensures required fields exist
            
            // Return success
            return {
              status: 'SUCCESS'
            };
          } catch (error) {
            console.error('Validation error:', error);
            return {
              status: 'FAILURE',
              errorMessage: error.message
            };
          }
        };
      `),
      description: `Validates configuration for ${props.applicationName}`,
    });
    
    // Add permissions to validate configurations
    const validationRole = props.validationRole || validationFunction.role!;
    
    return validationFunction;
  }
  
  private createConfigurationProfile(props: AppConfigIntegrationProps): appconfig.CfnConfigurationProfile {
    // Location template for S3-hosted configuration
    const locationUri = `s3://${props.configurationBucket.bucketName}/${props.configurationKey}`;
    
    // Create configuration profile
    const configProfile = new appconfig.CfnConfigurationProfile(this, 'ConfigProfile', {
      applicationId: this.application.ref,
      name: props.configurationProfileName,
      locationUri,
      retrievalRoleArn: this.createRetrievalRole(props).roleArn,
    });
    
    // Add validator if validation Lambda is provided
    if (this.validationLambda) {
      configProfile.validators = [
        {
          content: this.validationLambda.functionArn,
          type: 'LAMBDA',
        },
      ];
    }
    
    return configProfile;
  }
  
  private createRetrievalRole(props: AppConfigIntegrationProps): iam.Role {
    // Create role for AppConfig to retrieve configuration from S3
    const retrievalRole = new iam.Role(this, 'RetrievalRole', {
      assumedBy: new iam.ServicePrincipal('appconfig.amazonaws.com'),
      description: `Role for AppConfig to retrieve configuration from S3 for ${props.applicationName}`,
    });
    
    // Grant permission to read from S3
    retrievalRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        `${props.configurationBucket.arnForObjects(props.configurationKey)}`,
      ],
    }));
    
    return retrievalRole;
  }
}