/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface SageMakerAsyncEndpointStackProps {
  Name: string;
  modelExecutionRole: iam.IRole;
  models: Map<string, sagemaker.CfnModel>;
  outputBucket: s3.IBucket;
  notificationTopic?: sns.ITopic;
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
  asyncConfig?: {
    outputKmsKeyId?: string;
    maxConcurrentInvocationsPerInstance?: number;
    expiresInSeconds?: number;
  };
}

export class SageMakerAsyncEndpointStack extends BaseStack {
  public readonly endpoint: sagemaker.CfnEndpoint;
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;
  public readonly asyncQueue: sqs.Queue;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: SageMakerAsyncEndpointStackProps) {
    super(scope, stackConfig.Name, props, stackConfig);

    // Create SQS queue for async processing
    this.asyncQueue = new sqs.Queue(this, 'AsyncInferenceQueue', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(4),
    });

    // Create endpoint configuration with production variants
    const variants = stackConfig.endpointConfig.map(config => ({
      initialVariantWeight: 1.0,
      modelName: `${this.projectPrefix}-${config.modelName}`,
      variantName: config.variantName,
      instanceType: config.instanceType,
      initialInstanceCount: config.initialInstanceCount,
    }));

    // Create the endpoint config with async inference config
    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'AsyncEndpointConfig', {
      endpointConfigName: `${this.projectPrefix}-async-endpoint-config`,
      productionVariants: variants,
    });

    // Add async inference configuration using escape hatches
    const cfnEndpointConfig = this.endpointConfig.node.tryFindChild('Resource') as cdk.CfnResource;
    
    const asyncInferenceConfig: any = {
      OutputConfig: {
        S3OutputPath: `s3://${stackConfig.outputBucket.bucketName}/async-inference-output/`,
        NotificationConfig: {
          SuccessTopic: stackConfig.notificationTopic?.topicArn,
          ErrorTopic: stackConfig.notificationTopic?.topicArn
        }
      }
    };

    // Add optional async configurations
    if (stackConfig.asyncConfig?.outputKmsKeyId) {
      asyncInferenceConfig.OutputConfig.KmsKeyId = stackConfig.asyncConfig.outputKmsKeyId;
    }
    
    if (stackConfig.asyncConfig?.maxConcurrentInvocationsPerInstance) {
      asyncInferenceConfig.ClientConfig = {
        MaxConcurrentInvocationsPerInstance: stackConfig.asyncConfig.maxConcurrentInvocationsPerInstance
      };
    }

    if (stackConfig.asyncConfig?.expiresInSeconds) {
      asyncInferenceConfig.ClientConfig = {
        ...(asyncInferenceConfig.ClientConfig || {}),
        InvocationsTimeoutInSeconds: stackConfig.asyncConfig.expiresInSeconds
      };
    }

    // Make sure the CFN resource exists before attempting to modify it
    if (cfnEndpointConfig) {
      cfnEndpointConfig.addPropertyOverride('AsyncInferenceConfig', asyncInferenceConfig);
    }
    
    // Create the endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'AsyncEndpoint', {
      endpointName: `${this.projectPrefix}-async-endpoint`,
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
    });

    // Create IAM policy for invoking async endpoint
    const asyncInvokePolicy = new iam.ManagedPolicy(this, 'AsyncInvokePolicy', {
      managedPolicyName: `${this.projectPrefix}-async-invoke-policy`,
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'sagemaker:InvokeEndpointAsync'
          ],
          resources: [`arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${this.endpoint.endpointName}`]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:PutObject',
            's3:ListBucket'
          ],
          resources: [
            stackConfig.outputBucket.bucketArn,
            `${stackConfig.outputBucket.bucketArn}/*`
          ]
        })
      ]
    });

    // Export endpoint name and ARN
    new cdk.CfnOutput(this, 'AsyncEndpointName', {
      value: this.endpoint.attrEndpointName,
      exportName: `${this.projectPrefix}-async-endpoint-name`,
    });

    new cdk.CfnOutput(this, 'AsyncEndpointArn', {
      value: `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${this.endpoint.endpointName}`,
      exportName: `${this.projectPrefix}-async-endpoint-arn`,
    });

    new cdk.CfnOutput(this, 'AsyncInferenceQueueUrl', {
      value: this.asyncQueue.queueUrl,
      exportName: `${this.projectPrefix}-async-inference-queue-url`,
    });
  }
}
