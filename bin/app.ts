import * as cdk from 'aws-cdk-lib';
// import { SageMakerDeploymentStack } from '../lib/sagemaker-deployment-construct-stack';
import { SageMakerDeploymentStack } from '../lib/sagemaker-deployment-stack';
import { ConfigLoader } from '../config/config-loader';

// Get environment from command line args or use default
const app = new cdk.App();
const environment = app.node.tryGetContext('environment') || 'dev';

// Load environment-specific configuration
const configPath = `./config/${environment}-deployment.json`;
const deploymentConfig = ConfigLoader.loadConfig(configPath);
const constructProps = ConfigLoader.convertToConstructProps(deploymentConfig);

// Create the stack with the loaded configuration
new SageMakerDeploymentStack(app, `SageMakerDeployment-${environment}`, {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  deploymentConfig: constructProps,
});