// lib/autoscaling/scaling-configuration.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export enum ScalingMetric {
  CPU_UTILIZATION = 'CPUUtilization',
  MEMORY_UTILIZATION = 'MemoryUtilization',
  INVOCATIONS_PER_INSTANCE = 'InvocationsPerInstance',
  DISK_UTILIZATION = 'DiskUtilization',
  GPU_UTILIZATION = 'GPUUtilization',
  GPU_MEMORY_UTILIZATION = 'GPUMemoryUtilization',
}

export interface ScalingPolicy {
  readonly metric: ScalingMetric;
  readonly targetValue: number;
  readonly scaleInCooldown?: cdk.Duration;
  readonly scaleOutCooldown?: cdk.Duration;
  readonly disableScaleIn?: boolean;
}

export interface InstanceLimits {
  readonly minInstanceCount: number;
  readonly maxInstanceCount: number;
}

export interface SageMakerScalingProps {
  readonly endpointName: string;
  readonly variantName: string;
  readonly instanceLimits: InstanceLimits;
  readonly scalingPolicy: ScalingPolicy;
  readonly predefinedMetricType?: appscaling.PredefinedMetric;
  readonly customMetricName?: string;
  readonly customMetricNamespace?: string;
  readonly customMetricDimensions?: { [key: string]: string };
  readonly customMetricStatistic?: cloudwatch.Statistic;
}

export class SageMakerScaling extends Construct {
  public readonly scalableTarget: appscaling.ScalableTarget;
  public readonly scalingPolicy: appscaling.TargetTrackingScalingPolicy;

  constructor(scope: Construct, id: string, props: SageMakerScalingProps) {
    super(scope, id);

    // Create scalable target for the SageMaker endpoint variant
    this.scalableTarget = new appscaling.ScalableTarget(this, 'ScalableTarget', {
      serviceNamespace: appscaling.ServiceNamespace.SAGEMAKER,
      resourceId: `endpoint/${props.endpointName}/variant/${props.variantName}`,
      scalableDimension: 'sagemaker:variant:DesiredInstanceCount',
      minCapacity: props.instanceLimits.minInstanceCount,
      maxCapacity: props.instanceLimits.maxInstanceCount,
    });

    // Create scaling policy based on metric
    if (this.isPredefinedMetric(props.scalingPolicy.metric)) {
      // Use predefined metric-based scaling
      this.scalingPolicy = this.createPredefinedMetricScaling(props);
    } else {
      // Use custom metric-based scaling
      this.scalingPolicy = this.createCustomMetricScaling(props);
    }
  }

  private isPredefinedMetric(metric: ScalingMetric): boolean {
    return [
      ScalingMetric.CPU_UTILIZATION,
      ScalingMetric.MEMORY_UTILIZATION,
      ScalingMetric.INVOCATIONS_PER_INSTANCE
    ].includes(metric);
  }

  private createPredefinedMetricScaling(props: SageMakerScalingProps): appscaling.TargetTrackingScalingPolicy {
    // Map our metric enum to AWS predefined metrics
    const predefinedMetricType = this.mapToPredefinedMetric(props.scalingPolicy.metric);

    // Create target tracking scaling policy
    return new appscaling.TargetTrackingScalingPolicy(this, 'ScalingPolicy', {
      scalingTarget: this.scalableTarget,
      predefinedMetric: predefinedMetricType,
      targetValue: props.scalingPolicy.targetValue,
      scaleInCooldown: props.scalingPolicy.scaleInCooldown || cdk.Duration.seconds(300),
      scaleOutCooldown: props.scalingPolicy.scaleOutCooldown || cdk.Duration.seconds(60),
      disableScaleIn: props.scalingPolicy.disableScaleIn || false,
    });
  }

  private createCustomMetricScaling(props: SageMakerScalingProps): appscaling.TargetTrackingScalingPolicy {
    // Create custom metric
    const metricNamespace = props.customMetricNamespace || 'AWS/SageMaker';
    const metricName = props.customMetricName || this.getDefaultMetricName(props.scalingPolicy.metric);
    
    // Create dimensions
    const dimensions: { [key: string]: string } = {
      EndpointName: props.endpointName,
      VariantName: props.variantName,
      ...props.customMetricDimensions || {}
    };

    // Create custom metric specification
    const customMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: metricName,
      dimensionsMap: dimensions,
      statistic: props.customMetricStatistic || cloudwatch.Statistic.AVERAGE,
    });

    // Create target tracking scaling policy with custom metric
    return new appscaling.TargetTrackingScalingPolicy(this, 'CustomScalingPolicy', {
      scalingTarget: this.scalableTarget,
      customMetric: customMetric,
      targetValue: props.scalingPolicy.targetValue,
      scaleInCooldown: props.scalingPolicy.scaleInCooldown || cdk.Duration.seconds(300),
      scaleOutCooldown: props.scalingPolicy.scaleOutCooldown || cdk.Duration.seconds(60),
      disableScaleIn: props.scalingPolicy.disableScaleIn || false,
    });
  }

  private mapToPredefinedMetric(metric: ScalingMetric): appscaling.PredefinedMetric {
    switch (metric) {
      case ScalingMetric.CPU_UTILIZATION:
        return appscaling.PredefinedMetric.SAGEMAKER_VARIANT_PROVISIONED_CONCURRENCY_UTILIZATION;
      case ScalingMetric.MEMORY_UTILIZATION:
        return appscaling.PredefinedMetric.SAGEMAKER_INFERENCE_COMPONENT_CONCURRENT_REQUESTS_PER_COPY_HIGH_RESOLUTION;
      case ScalingMetric.INVOCATIONS_PER_INSTANCE:
        return appscaling.PredefinedMetric.SAGEMAKER_VARIANT_INVOCATIONS_PER_INSTANCE;
      default:
        throw new Error(`No predefined metric mapping for ${metric}`);
    }
  }

  private getDefaultMetricName(metric: ScalingMetric): string {
    switch (metric) {
      case ScalingMetric.DISK_UTILIZATION:
        return 'DiskUtilization';
      case ScalingMetric.GPU_UTILIZATION:
        return 'GPUUtilization';
      case ScalingMetric.GPU_MEMORY_UTILIZATION:
        return 'GPUMemoryUtilization';
      default:
        return metric;
    }
  }
}