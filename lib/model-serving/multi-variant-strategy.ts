// lib/multi-variant-strategy.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cdk from 'aws-cdk-lib';
import { DeploymentResult, DeploymentStrategyProps, IDeploymentStrategy } from './deployment-strategy';
import { AppConfigIntegration } from '../appConfig/appconfig-integration';

export class MultiVariantStrategy implements IDeploymentStrategy {
  private readonly props: DeploymentStrategyProps;
  private readonly appConfig: AppConfigIntegration;

  constructor(props: DeploymentStrategyProps) {
    this.props = props;
    
    if (this.props.modelConfigs.length < 1) {
      throw new Error('At least one model configuration must be provided');
    }
  }

  public deploy(): DeploymentResult {
    // Create models for each configuration
    const models = this.props.modelConfigs.map((modelConfig, index) => {
      return new sagemaker.CfnModel(this.props.scope, `${this.props.id}Model${index}`, {
        executionRoleArn: this.props.executionRole.roleArn,
        primaryContainer: {
          modelDataUrl: `s3://${modelConfig.modelArtifacts.bucketName}/${modelConfig.modelArtifacts.objectKey}`,
          image: modelConfig.containerImage,
          environment: {
            // Environment variables for AppConfig integration
            APPCONFIG_APPLICATION: this.appConfig.application.ref,
            APPCONFIG_ENVIRONMENT: this.appConfig.environment.ref,
            APPCONFIG_PROFILE: this.appConfig.configurationProfile.ref,
            APPCONFIG_REGION: cdk.Stack.of(this.props.scope).region,
            // Add polling interval (in seconds)
            APPCONFIG_POLL_INTERVAL: '60',
            // Add flag to enable configuration caching
            APPCONFIG_ENABLE_CACHE: 'true',
          },
        },
        modelName: modelConfig.modelName,
        vpcConfig: this.props.vpcConfig,
        enableNetworkIsolation: this.props.enableNetworkIsolation ?? false,
        tags: this.convertToTags({
          ...this.props.tags || {},
          VariantName: modelConfig.variantName,
        }),
      });
    });
    
    // Create endpoint config with all variants
    const endpointConfig = new sagemaker.CfnEndpointConfig(this.props.scope, `${this.props.id}EndpointConfig`, {
      productionVariants: this.props.modelConfigs.map((modelConfig, index) => ({
        initialVariantWeight: modelConfig.initialVariantWeight,
        modelName: models[index].attrModelName,
        variantName: modelConfig.variantName,
        initialInstanceCount: modelConfig.initialInstanceCount,
        instanceType: modelConfig.instanceType,
      })),
      tags: this.convertToTags(this.props.tags || {}),
      kmsKeyId: this.props.kmsKeyId,
    });
    
    // Create endpoint
    const endpoint = new sagemaker.CfnEndpoint(this.props.scope, `${this.props.id}Endpoint`, {
      endpointConfigName: endpointConfig.attrEndpointConfigName,
      endpointName: this.props.endpointName || `${this.props.modelConfigs[0].modelName}-endpoint`,
      tags: this.convertToTags(this.props.tags || {}),
    });
    
    return {
      model: models,
      endpointConfig,
      endpoint,
    };
  }
  
  private convertToTags(tags: Record<string, string>): cdk.CfnTag[] {
    return Object.entries(tags).map(([key, value]) => ({
      key,
      value,
    }));
  }
}