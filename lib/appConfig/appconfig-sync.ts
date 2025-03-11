// lib/config/appconfig-sync.ts
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface AppConfigSyncProps {
  applicationName: string;
  environmentName: string;
  configurationProfileName: string;
  configBucket: string;
  configKey: string;
  deploymentStrategy?: string;
}

export class AppConfigSync extends Construct {
  constructor(scope: Construct, id: string, props: AppConfigSyncProps) {
    super(scope, id);

    // Create Lambda function for syncing config
    const syncFunction = this.createSyncFunction(props);
    
    // Create custom resource provider
    const provider = new cr.Provider(this, 'SyncProvider', {
      onEventHandler: syncFunction,
    });
    
    // Create custom resource for config sync
    new cdk.CustomResource(this, 'ConfigSync', {
      serviceToken: provider.serviceToken,
      properties: {
        ApplicationName: props.applicationName,
        EnvironmentName: props.environmentName,
        ConfigurationProfileName: props.configurationProfileName,
        ConfigBucket: props.configBucket,
        ConfigKey: props.configKey,
        DeploymentStrategy: props.deploymentStrategy || 'Immediate',
        Timestamp: Date.now().toString(), // Force update on stack updates
      },
    });
  }
  
  private createSyncFunction(props: AppConfigSyncProps): lambda.Function {
    // Create Lambda function for handling config syncing
    const fn = new lambda.Function(this, 'SyncFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        const appconfig = new AWS.AppConfig();
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          // Extract properties
          const props = event.ResourceProperties;
          const {
            ApplicationName,
            EnvironmentName,
            ConfigurationProfileName,
            ConfigBucket,
            ConfigKey,
            DeploymentStrategy,
          } = props;
          
          try {
            if (event.RequestType === 'Create' || event.RequestType === 'Update') {
              // 1. Get application ID (create if doesn't exist)
              let applicationId;
              try {
                const appResponse = await appconfig.getApplication({
                  Application: ApplicationName
                }).promise();
                applicationId = appResponse.Id;
                console.log('Found existing application:', applicationId);
              } catch (err) {
                const createAppResponse = await appconfig.createApplication({
                  Name: ApplicationName,
                  Description: \`Application for \${ApplicationName}\`,
                }).promise();
                applicationId = createAppResponse.Id;
                console.log('Created new application:', applicationId);
              }
              
              // 2. Get environment ID (create if doesn't exist)
              let environmentId;
              try {
                const envResponse = await appconfig.getEnvironment({
                  Application: applicationId,
                  Environment: EnvironmentName
                }).promise();
                environmentId = envResponse.Id;
                console.log('Found existing environment:', environmentId);
              } catch (err) {
                const createEnvResponse = await appconfig.createEnvironment({
                  ApplicationId: applicationId,
                  Name: EnvironmentName,
                  Description: \`Environment for \${ApplicationName}\`,
                }).promise();
                environmentId = createEnvResponse.Id;
                console.log('Created new environment:', environmentId);
              }
              
              // 3. Get configuration profile ID (create if doesn't exist)
              let profileId;
              try {
                const profileResponse = await appconfig.getConfigurationProfile({
                  ApplicationId: applicationId,
                  ConfigurationProfileId: ConfigurationProfileName
                }).promise();
                profileId = profileResponse.Id;
                console.log('Found existing configuration profile:', profileId);
              } catch (err) {
                // Create a retrievalRoleArn with permissions to access S3
                // In a real implementation, you'd want to create this role properly
                // This is just a placeholder
                const retrievalRoleArn = \`arn:aws:iam::\${process.env.AWS_ACCOUNT_ID}:role/AppConfigRetrievalRole\`;
                
                const createProfileResponse = await appconfig.createConfigurationProfile({
                  ApplicationId: applicationId,
                  Name: ConfigurationProfileName,
                  LocationUri: \`s3://\${ConfigBucket}/\${ConfigKey}\`,
                  RetrievalRoleArn: retrievalRoleArn,
                }).promise();
                profileId = createProfileResponse.Id;
                console.log('Created new configuration profile:', profileId);
              }
              
              // 4. Get S3 configuration content
              const s3Response = await s3.getObject({
                Bucket: ConfigBucket,
                Key: ConfigKey,
              }).promise();
              
              const configContent = s3Response.Body.toString('utf-8');
              console.log('Retrieved configuration content from S3');
              
              // 5. Create a hosted configuration version
              const versionResponse = await appconfig.createHostedConfigurationVersion({
                ApplicationId: applicationId,
                ConfigurationProfileId: profileId,
                Content: Buffer.from(configContent),
                ContentType: 'application/json',
              }).promise();
              
              console.log('Created hosted configuration version:', versionResponse.VersionNumber);
              
              // 6. Get deployment strategy ID
              let strategyId;
              try {
                const strategies = await appconfig.listDeploymentStrategies({}).promise();
                const strategy = strategies.Items.find(s => s.Name === DeploymentStrategy);
                if (strategy) {
                  strategyId = strategy.Id;
                } else {
                  // Use default predefined strategy
                  strategyId = 'AppConfig.AllAtOnce'; // Default predefined strategy
                }
                console.log('Using deployment strategy:', strategyId);
              } catch (err) {
                strategyId = 'AppConfig.AllAtOnce'; // Default predefined strategy
                console.log('Using default deployment strategy');
              }
              
              // 7. Start deployment
              const deploymentResponse = await appconfig.startDeployment({
                ApplicationId: applicationId,
                EnvironmentId: environmentId,
                DeploymentStrategyId: strategyId,
                ConfigurationProfileId: profileId,
                ConfigurationVersion: versionResponse.VersionNumber.toString(),
              }).promise();
              
              console.log('Started deployment:', deploymentResponse.DeploymentNumber);
              
              return {
                PhysicalResourceId: \`\${applicationId}-\${environmentId}-\${profileId}\`,
                Data: {
                  ApplicationId: applicationId,
                  EnvironmentId: environmentId,
                  ProfileId: profileId,
                  DeploymentNumber: deploymentResponse.DeploymentNumber,
                },
              };
            }
            
            if (event.RequestType === 'Delete') {
              // Optionally clean up resources
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
      description: 'Custom resource to sync S3 configs to AppConfig',
      environment: {
        AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      },
    });
    
    // Add necessary permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject',
      ],
      resources: [`arn:aws:s3:::${props.configBucket}/${props.configKey}`],
    }));
    
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:GetApplication',
        'appconfig:CreateApplication',
        'appconfig:GetEnvironment',
        'appconfig:CreateEnvironment',
        'appconfig:GetConfigurationProfile',
        'appconfig:CreateConfigurationProfile',
        'appconfig:CreateHostedConfigurationVersion',
        'appconfig:ListDeploymentStrategies',
        'appconfig:StartDeployment',
      ],
      resources: ['*'],
    }));
    
    return fn;
  }
}