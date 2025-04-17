import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface SageMakerEndpointStackProps {
  Name: string;
  modelExecutionRole: iam.IRole;
  models: Map<string, sagemaker.CfnModel>;
  endpointConfig: {
    variantName: string;
    modelName: string;
    instanceType: string;
    initialInstanceCount: number;
    autoScaling?: {
      minCapacity: number;
      maxCapacity: number;
      targetInvocationsPerInstance: number;
    };
  }[];
}

export class SageMakerEndpointStack extends BaseStack {
  public readonly endpoint: sagemaker.CfnEndpoint;
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: SageMakerEndpointStackProps) {
    super(scope, 'SageMakerEndpointStack', props, stackConfig);

    // Create endpoint configuration with production variants
    const variants = stackConfig.endpointConfig.map(config => ({
      initialVariantWeight: 1.0,
      modelName: `${this.projectPrefix}-${config.modelName}`,
      variantName: config.variantName,
      instanceType: config.instanceType,
      initialInstanceCount: config.initialInstanceCount,
    }));

    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      endpointConfigName: `${this.projectPrefix}-endpoint-config`,
      productionVariants: variants,
    });

    // Create the endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointName: `${this.projectPrefix}-endpoint`,
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
    });

    // Set up auto-scaling for each variant if configured
    stackConfig.endpointConfig.forEach((config, index) => {
      if (config.autoScaling) {
        const target = new autoscaling.ScalableTarget(this, `ScalableTarget-${config.variantName}`, {
          serviceNamespace: autoscaling.ServiceNamespace.SAGEMAKER,
          maxCapacity: config.autoScaling.maxCapacity,
          minCapacity: config.autoScaling.minCapacity,
          resourceId: `endpoint/${this.endpoint.endpointName}/variant/${config.variantName}`,
          scalableDimension: 'sagemaker:variant:DesiredInstanceCount',
        });

        target.scaleToTrackMetric('InvocationsTracking', {
          targetValue: config.autoScaling.targetInvocationsPerInstance,
          predefinedMetric: autoscaling.PredefinedMetric.SAGEMAKER_VARIANT_INVOCATIONS_PER_INSTANCE,
        });
      }
    });

    // Export endpoint name and ARN
    new cdk.CfnOutput(this, 'EndpointName', {
      value: this.endpoint.attrEndpointName,
      exportName: `${this.projectPrefix}-endpoint-name`,
    });

    new cdk.CfnOutput(this, 'EndpointArn', {
      value: this.endpoint.attrEndpointArn,
      exportName: `${this.projectPrefix}-endpoint-arn`,
    });
  }
}