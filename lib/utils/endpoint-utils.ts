/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

/**
 * Utility class for SageMaker endpoint configurations and deployments
 */
export class EndpointUtils {
  /**
   * Creates a SageMaker model deployment configuration
   */
  public static createEndpointConfig(
    scope: Construct,
    id: string,
    options: {
      projectPrefix: string;
      variants: Array<{
        modelName: string;
        variantName: string;
        instanceType: string;
        initialInstanceCount: number;
        initialVariantWeight?: number;
        modelDataDownloadTimeoutInSeconds?: number;
        containerStartupHealthCheckTimeoutInSeconds?: number;
      }>;
      dataCaptureSamplePercentage?: number;
      dataCaptureS3Location?: string;
      kmsKey?: string;
    }
  ): sagemaker.CfnEndpointConfig {
    // Create production variants configuration
    const variants = options.variants.map(variant => {
      const productionVariant: any = {
        modelName: `${options.projectPrefix}-${variant.modelName}`,
        variantName: variant.variantName,
        instanceType: variant.instanceType,
        initialInstanceCount: variant.initialInstanceCount,
        initialVariantWeight: variant.initialVariantWeight || 1.0,
      };

      // Add optional timeout configurations if provided
      if (variant.modelDataDownloadTimeoutInSeconds) {
        productionVariant.modelDataDownloadTimeoutInSeconds = variant.modelDataDownloadTimeoutInSeconds;
      }

      if (variant.containerStartupHealthCheckTimeoutInSeconds) {
        productionVariant.containerStartupHealthCheckTimeoutInSeconds = 
          variant.containerStartupHealthCheckTimeoutInSeconds;
      }

      return productionVariant;
    });

    // Create endpoint configuration
    const endpointConfigProps: sagemaker.CfnEndpointConfigProps = {
      endpointConfigName: `${options.projectPrefix}-endpoint-config`,
      productionVariants: variants,
    };

    // Add data capture configuration if capture percentage is provided
    if (options.dataCaptureSamplePercentage && options.dataCaptureS3Location) {
      // Create the endpoint config first, then modify its properties
      const endpointConfig = new sagemaker.CfnEndpointConfig(scope, id, endpointConfigProps);
      
      // Add data capture config using escape hatches
      const cfnEndpointConfig = endpointConfig.node.defaultChild as cdk.CfnResource;
      cfnEndpointConfig.addPropertyOverride('DataCaptureConfig', {
        CaptureContentTypeHeader: {
          CsvContentTypes: ['text/csv'],
          JsonContentTypes: ['application/json'],
        },
        CaptureOptions: [
          {
            CaptureMode: 'Input',
          },
          {
            CaptureMode: 'Output',
          },
        ],
        DestinationS3Uri: options.dataCaptureS3Location,
        InitialSamplingPercentage: options.dataCaptureSamplePercentage,
      });

      // Add KMS key if provided
      if (options.kmsKey) {
        cfnEndpointConfig.addPropertyOverride('KmsKeyId', options.kmsKey);
      }
      
      return endpointConfig;
    }
    
    // Create and return the endpoint configuration
    return new sagemaker.CfnEndpointConfig(scope, id, endpointConfigProps);
  }

  /**
   * Creates a SageMaker endpoint with the given configuration
   */
  public static createEndpoint(
    scope: Construct,
    id: string,
    options: {
      projectPrefix: string;
      endpointConfigName: string;
      endpointName?: string;
      tags?: { [key: string]: string };
    }
  ): sagemaker.CfnEndpoint {
    // Create the endpoint
    const endpoint = new sagemaker.CfnEndpoint(scope, id, {
      endpointName: options.endpointName || `${options.projectPrefix}-endpoint`,
      endpointConfigName: options.endpointConfigName,
      tags: options.tags ? Object.entries(options.tags).map(([key, value]) => ({
        key,
        value,
      })) : undefined,
    });

    return endpoint;
  }

  /**
   * Configures auto-scaling for a SageMaker endpoint variant
   */
  public static setupAutoScaling(
    scope: Construct,
    id: string,
    options: {
      endpointName: string;
      variantName: string;
      minCapacity: number;
      maxCapacity: number;
      targetMetric: 'InvocationsPerInstance' | 'CPUUtilization' | 'MemoryUtilization' | 'GPUUtilization';
      targetValue: number;
      scaleInCooldown?: cdk.Duration;
      scaleOutCooldown?: cdk.Duration;
    }
  ): autoscaling.ScalableTarget {
    // Create the scalable target
    const scalableTarget = new autoscaling.ScalableTarget(scope, id, {
      serviceNamespace: autoscaling.ServiceNamespace.SAGEMAKER,
      maxCapacity: options.maxCapacity,
      minCapacity: options.minCapacity,
      resourceId: `endpoint/${options.endpointName}/variant/${options.variantName}`,
      scalableDimension: 'sagemaker:variant:DesiredInstanceCount',
    });

    // Set up scaling policy based on target metric
    switch (options.targetMetric) {
      case 'CPUUtilization':
        scalableTarget.scaleToTrackMetric(`${id}CPUTracking`, {
          targetValue: options.targetValue,
          customMetric: new cloudwatch.Metric({
            namespace: 'AWS/SageMaker',
            metricName: 'CPUUtilization',
            dimensionsMap: {
              EndpointName: options.endpointName,
              VariantName: options.variantName
            },
            statistic: 'Average'
          }),
          scaleInCooldown: options.scaleInCooldown,
          scaleOutCooldown: options.scaleOutCooldown,
        });
        break;
      case 'MemoryUtilization':
        scalableTarget.scaleToTrackMetric(`${id}MemoryTracking`, {
          targetValue: options.targetValue,
          customMetric: new cloudwatch.Metric({
            namespace: 'AWS/SageMaker',
            metricName: 'MemoryUtilization',
            dimensionsMap: {
              EndpointName: options.endpointName,
              VariantName: options.variantName
            },
            statistic: 'Average'
          }),
          scaleInCooldown: options.scaleInCooldown,
          scaleOutCooldown: options.scaleOutCooldown,
        });
        break;
      case 'GPUUtilization':
        scalableTarget.scaleToTrackMetric(`${id}GPUTracking`, {
          targetValue: options.targetValue,
          customMetric: new cloudwatch.Metric({
            namespace: 'AWS/SageMaker',
            metricName: 'GPUUtilization',
            dimensionsMap: {
              EndpointName: options.endpointName,
              VariantName: options.variantName
            },
            statistic: 'Average'
          }),
          scaleInCooldown: options.scaleInCooldown,
          scaleOutCooldown: options.scaleOutCooldown,
        });
        break;
      case 'InvocationsPerInstance':
      default:
        scalableTarget.scaleToTrackMetric(`${id}InvocationsTracking`, {
          targetValue: options.targetValue,
          predefinedMetric: autoscaling.PredefinedMetric.SAGEMAKER_VARIANT_INVOCATIONS_PER_INSTANCE,
          scaleInCooldown: options.scaleInCooldown,
          scaleOutCooldown: options.scaleOutCooldown,
        });
        break;
    }

    return scalableTarget;
  }

  /**
   * Updates SageMaker endpoint weights and capacity
   */
  public static createEndpointUpdater(
    scope: Construct,
    id: string,
    options: {
      projectPrefix: string;
      endpointName: string;
      variants: Array<{
        variantName: string;
        weight?: number;
        instanceCount?: number;
      }>;
      lambdaRole: iam.IRole;
    }
  ): lambda.Function {
    // Create Lambda function for updating endpoint weights and capacity
    const updateFunction = new lambda.Function(scope, id, {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('codes/lambda/endpoint-updater'),
      role: options.lambdaRole,
      environment: {
        ENDPOINT_NAME: options.endpointName,
        VARIANTS_CONFIG: JSON.stringify(options.variants),
      },
      timeout: cdk.Duration.minutes(5),
    });

    // If the role is not an interface, add policies
    if (options.lambdaRole instanceof iam.Role) {
      options.lambdaRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:UpdateEndpointWeightsAndCapacities',
          'sagemaker:DescribeEndpoint',
        ],
        resources: [`arn:aws:sagemaker:*:*:endpoint/${options.endpointName}`],
      }));
    }

    return updateFunction;
  }

  /**
   * Creates a deployment strategy helper for blue/green deployments
   */
  public static createBlueGreenDeployment(
    scope: Construct, 
    id: string,
    options: {
      projectPrefix: string;
      endpointName: string;
      newVariantConfig: {
        modelName: string;
        variantName: string;
        instanceType: string;
        initialInstanceCount: number;
      };
      existingVariantName: string;
      evaluationPeriodMinutes: number;
      trafficShiftSteps: number;
    }
  ): {
    stateMachine: sfn.StateMachine;
    role: iam.Role;
  } {
    // Create IAM role for the state machine
    const stateRole = new iam.Role(scope, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add permissions for SageMaker operations
    stateRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sagemaker:CreateEndpointConfig',
        'sagemaker:UpdateEndpoint',
        'sagemaker:UpdateEndpointWeightsAndCapacities',
        'sagemaker:DescribeEndpoint',
        'sagemaker:DescribeEndpointConfig',
        'sagemaker:DeleteEndpointConfig',
      ],
      resources: ['*'],
    }));

    // Create Lambda for endpoint config creation
    const createConfigLambda = new lambda.Function(scope, `${id}CreateConfig`, {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'create_config.handler',
      code: lambda.Code.fromAsset('codes/lambda/blue-green-deployment'),
      environment: {
        PROJECT_PREFIX: options.projectPrefix,
        ENDPOINT_NAME: options.endpointName,
        NEW_MODEL_NAME: options.newVariantConfig.modelName,
        NEW_VARIANT_NAME: options.newVariantConfig.variantName,
        INSTANCE_TYPE: options.newVariantConfig.instanceType,
        INSTANCE_COUNT: options.newVariantConfig.initialInstanceCount.toString(),
        EXISTING_VARIANT_NAME: options.existingVariantName,
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Create Lambda for traffic shifting
    const shiftTrafficLambda = new lambda.Function(scope, `${id}ShiftTraffic`, {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'shift_traffic.handler',
      code: lambda.Code.fromAsset('codes/lambda/blue-green-deployment'),
      environment: {
        ENDPOINT_NAME: options.endpointName,
        NEW_VARIANT_NAME: options.newVariantConfig.variantName,
        EXISTING_VARIANT_NAME: options.existingVariantName,
        TRAFFIC_SHIFT_STEPS: options.trafficShiftSteps.toString(),
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Create Lambda for final config cleanup
    const finalizeDeploymentLambda = new lambda.Function(scope, `${id}FinalizeDeployment`, {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'finalize_deployment.handler',
      code: lambda.Code.fromAsset('codes/lambda/blue-green-deployment'),
      environment: {
        ENDPOINT_NAME: options.endpointName,
        NEW_VARIANT_NAME: options.newVariantConfig.variantName,
        EXISTING_VARIANT_NAME: options.existingVariantName,
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions to the Lambdas
    createConfigLambda.grantInvoke(stateRole);
    shiftTrafficLambda.grantInvoke(stateRole);
    finalizeDeploymentLambda.grantInvoke(stateRole);

    // Create Step Functions state machine definition
    const definition = new sfn.Pass(scope, `${id}StartDeployment`)
      .next(new tasks.LambdaInvoke(scope, `${id}CreateNewEndpointConfig`, {
        lambdaFunction: createConfigLambda,
        resultPath: '$.configResult',
      }))
      .next(new sfn.Wait(scope, `${id}WaitForEndpointUpdate`, {
        time: sfn.WaitTime.duration(cdk.Duration.minutes(10)),
      }))
      .next(new tasks.LambdaInvoke(scope, `${id}ShiftTrafficGradually`, {
        lambdaFunction: shiftTrafficLambda,
        resultPath: '$.trafficResult',
      }))
      .next(new sfn.Wait(scope, `${id}EvaluateNewVariant`, {
        time: sfn.WaitTime.duration(cdk.Duration.minutes(options.evaluationPeriodMinutes)),
      }))
      .next(new tasks.LambdaInvoke(scope, `${id}FinalizeDeployment`, {
        lambdaFunction: finalizeDeploymentLambda,
        resultPath: '$.finalizeResult',
      }));

    // Create the state machine
    const stateMachine = new sfn.StateMachine(scope, id, {
      definition,
      role: stateRole,
    });

    return {
      stateMachine,
      role: stateRole,
    };
  }
}
