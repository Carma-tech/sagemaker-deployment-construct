/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface SageMakerServerlessEndpointStackProps {
  Name: string;
  modelExecutionRole: iam.IRole;
  models: Map<string, sagemaker.CfnModel>;
  serverlessConfig: {
    variantName: string;
    modelName: string;
    memorySize?: number; // Between 1024 and 6144 (1GB to 6GB), in 1GB increments
    maxConcurrency?: number; // 1-200, default is 5
  }[];
}

export class SageMakerServerlessEndpointStack extends BaseStack {
  public readonly endpoint: sagemaker.CfnEndpoint;
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: SageMakerServerlessEndpointStackProps) {
    super(scope, stackConfig.Name, props, stackConfig);

    // Validate the number of variants
    if (stackConfig.serverlessConfig.length > 5) {
      throw new Error('Serverless endpoints support a maximum of 5 production variants');
    }

    // Create endpoint configuration with serverless variants
    const variants = stackConfig.serverlessConfig.map(config => {
      // Ensure memory size is valid (1GB to 6GB in 1GB increments)
      const memorySize = config.memorySize || 2048; // Default to 2GB
      if (memorySize < 1024 || memorySize > 6144 || memorySize % 1024 !== 0) {
        throw new Error(`Invalid memory size: ${memorySize}. Must be between 1024 and 6144 in increments of 1024.`);
      }

      // Ensure concurrency is valid (1-200)
      const maxConcurrency = config.maxConcurrency || 5; // Default to 5
      if (maxConcurrency < 1 || maxConcurrency > 200) {
        throw new Error(`Invalid max concurrency: ${maxConcurrency}. Must be between 1 and 200.`);
      }

      return {
        variantName: config.variantName,
        modelName: `${this.projectPrefix}-${config.modelName}`,
      };
    });

    // Create the endpoint config with serverless config
    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'ServerlessEndpointConfig', {
      endpointConfigName: `${this.projectPrefix}-serverless-endpoint-config`,
      productionVariants: variants,
    });

    // Add serverless config using escape hatches
    const cfnEndpointConfig = this.endpointConfig.node.defaultChild as cdk.CfnResource;
    
    // Add serverless config for each variant
    stackConfig.serverlessConfig.forEach((config, index) => {
      cfnEndpointConfig.addPropertyOverride(`ProductionVariants.${index}.ServerlessConfig`, {
        MemorySizeInMB: config.memorySize || 2048,
        MaxConcurrency: config.maxConcurrency || 5
      });
    });

    // Create the endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'ServerlessEndpoint', {
      endpointName: `${this.projectPrefix}-serverless-endpoint`,
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
    });

    // Create IAM policy for invoking serverless endpoint
    const serverlessInvokePolicy = new iam.ManagedPolicy(this, 'ServerlessInvokePolicy', {
      managedPolicyName: `${this.projectPrefix}-serverless-invoke-policy`,
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'sagemaker:InvokeEndpoint'
          ],
          resources: [this.endpoint.attrEndpointArn]
        })
      ]
    });

    // Export endpoint name and ARN
    new cdk.CfnOutput(this, 'ServerlessEndpointName', {
      value: this.endpoint.attrEndpointName,
      exportName: `${this.projectPrefix}-serverless-endpoint-name`,
    });

    new cdk.CfnOutput(this, 'ServerlessEndpointArn', {
      value: this.endpoint.attrEndpointArn,
      exportName: `${this.projectPrefix}-serverless-endpoint-arn`,
    });
  }
}
