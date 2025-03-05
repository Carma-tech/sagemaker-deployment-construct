// lib/autoscaling/endpoint-scaling.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SageMakerScaling, ScalingMetric, ScalingPolicy, InstanceLimits } from './scaling-configration';

export interface VariantScalingConfig {
  readonly variantName: string;
  readonly instanceLimits: InstanceLimits;
  readonly scalingPolicy: ScalingPolicy;
}

export interface EndpointScalingProps {
  readonly endpointName: string;
  readonly variants: VariantScalingConfig[];
}

export class EndpointScaling extends Construct {
  public readonly variantScalingConfigs: Map<string, SageMakerScaling> = new Map();

  constructor(scope: Construct, id: string, props: EndpointScalingProps) {
    super(scope, id);

    // Create scaling configuration for each variant
    props.variants.forEach((variant, index) => {
      const scaling = new SageMakerScaling(this, `Scaling-${variant.variantName}`, {
        endpointName: props.endpointName,
        variantName: variant.variantName,
        instanceLimits: variant.instanceLimits,
        scalingPolicy: variant.scalingPolicy,
      });

      this.variantScalingConfigs.set(variant.variantName, scaling);
    });
  }
}