// lib/sagemaker-deployment-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { SageMakerDeployment } from './base/base-stack';
import { AppConfigSync } from './appConfig/appconfig-sync';

export interface SageMakerDeploymentStackProps extends cdk.StackProps {
  deploymentConfig: any; // The loaded configuration
}

export class SageMakerDeploymentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SageMakerDeploymentStackProps) {
    super(scope, id, props);

    const config = props.deploymentConfig;

    // Resolve VPC if specified
    let vpc: ec2.IVpc | undefined;
    let securityGroups: ec2.ISecurityGroup[] | undefined;

    if (config.network?.vpcId) {
      vpc = ec2.Vpc.fromLookup(this, 'ImportedVpc', {
        vpcId: config.network.vpcId,
      });

      if (config.network.securityGroupIds && config.network.securityGroupIds.length > 0) {
        securityGroups = config.network.securityGroupIds.map((sgId: string, index: number) =>
          ec2.SecurityGroup.fromSecurityGroupId(this, `ImportedSG${index}`, sgId)
        );
      }
    }

    // Get model artifacts from the first model in the array
    // const modelArtifacts = config.models && config.models.length > 0 ? config.models[0].artifacts : undefined;
    const modelArtifacts = {
      bucketName: config.models[0].artifacts.bucketName,
      objectKey: `models/${config.models[0].artifacts.objectKey}`, // Ensure correct path
    };

    console.log('Model artifacts:', JSON.stringify(modelArtifacts));

    // Get instance type and count from the first model
    const instanceType = config.models && config.models.length > 0 ? config.models[0].instanceType : undefined;
    const initialInstanceCount = config.models && config.models.length > 0 ? config.models[0].initialInstanceCount : undefined;

    // Create SageMaker deployment with the loaded config
    new SageMakerDeployment(this, 'SageMakerDeployment', {
      modelName: config.namePrefix,
      modelArtifacts: modelArtifacts, // Add this line to map artifacts from the first model
      instanceType: instanceType, // Add instance type
      initialInstanceCount: initialInstanceCount, // Add instance count
      ...config,
      network: config.network ? {
        ...config.network,
        vpc,
        existingSecurityGroups: securityGroups,
      } : undefined,
    });

    // Sync runtime configuration to AppConfig
    new AppConfigSync(this, 'ConfigSync', {
      applicationName: config.appConfig.applicationName,
      environmentName: config.appConfig.environmentName,
      configurationProfileName: config.appConfig.configurationProfileName,
      configBucket: config.appConfig.configBucket,
      configKey: config.appConfig.configKey,
      deploymentStrategy: 'AppConfig.AllAtOnce', // Or specify a different strategy
    });
  }
}