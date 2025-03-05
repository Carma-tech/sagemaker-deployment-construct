// lib/single-endpoint-strategy.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cdk from 'aws-cdk-lib';
import { DeploymentResult, DeploymentStrategyProps, IDeploymentStrategy } from './deployment-strategy';
import { AppConfigIntegration } from '../app-config/app-config-integration';

export class SingleEndpointStrategy implements IDeploymentStrategy {
  private readonly props: DeploymentStrategyProps;
  private readonly appConfig: AppConfigIntegration;

  constructor(props: DeploymentStrategyProps) {
    this.props = props;
  }

  public deploy(): DeploymentResult {
    // Use the first model config to create a single model and endpoint
    const modelConfig = this.props.modelConfigs[0];
    
    // Create model
    const model = new sagemaker.CfnModel(this.props.scope, `${this.props.id}Model`, {
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
      tags: this.convertToTags(this.props.tags || {}),
    });
    
    // Create endpoint config
    const endpointConfig = new sagemaker.CfnEndpointConfig(this.props.scope, `${this.props.id}EndpointConfig`, {
      productionVariants: [
        {
          initialVariantWeight: modelConfig.initialVariantWeight,
          modelName: model.attrModelName,
          variantName: modelConfig.variantName,
          initialInstanceCount: modelConfig.initialInstanceCount,
          instanceType: modelConfig.instanceType,
        },
      ],
      tags: this.convertToTags(this.props.tags || {}),
      kmsKeyId: this.props.kmsKeyId,
    });
    
    // Create endpoint
    const endpoint = new sagemaker.CfnEndpoint(this.props.scope, `${this.props.id}Endpoint`, {
      endpointConfigName: endpointConfig.attrEndpointConfigName,
      endpointName: this.props.endpointName || `${modelConfig.modelName}-endpoint`,
      tags: this.convertToTags(this.props.tags || {}),
    });
    
    return {
      model,
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
