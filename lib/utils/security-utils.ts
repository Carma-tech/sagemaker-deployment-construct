/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Utility class for security-related resources like IAM roles, policies, and encryption
 */
export class SecurityUtils {
  /**
   * Creates a SageMaker execution role with necessary permissions
   */
  public static createSageMakerExecutionRole(
    scope: Construct,
    id: string,
    projectPrefix: string,
    options: {
      includeS3ReadAccess?: boolean;
      includeS3WriteAccess?: boolean;
      includeAppConfigAccess?: boolean;
      includeCloudWatchAccess?: boolean;
      customPolicyStatements?: iam.PolicyStatement[];
      roleName?: string;
    } = {}
  ): iam.Role {
    // Create base role for SageMaker
    const role = new iam.Role(scope, id, {
      roleName: options.roleName || `${projectPrefix}-${id}`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
    });

    // Add optional policies based on requested access
    if (options.includeS3ReadAccess) {
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:ListBucket',
        ],
        resources: ['*'],
      }));
    }

    if (options.includeS3WriteAccess) {
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:PutObject',
          's3:DeleteObject',
        ],
        resources: ['*'],
      }));
    }

    if (options.includeAppConfigAccess) {
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'appconfig:GetConfiguration',
          'appconfig:StartConfigurationSession',
        ],
        resources: ['*'],
      }));
    }

    if (options.includeCloudWatchAccess) {
      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricData',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['*'],
      }));
    }

    // Add any custom policy statements
    if (options.customPolicyStatements) {
      options.customPolicyStatements.forEach(statement => {
        role.addToPolicy(statement);
      });
    }

    return role;
  }

  /**
   * Creates an IAM role for fetching AppConfig configurations
   */
  public static createAppConfigFetcherRole(
    scope: Construct,
    id: string,
    options: {
      prefix: string;
      appConfigArn: string;
      configBucketArn: string;
    }
  ): iam.Role {
    const role = new iam.Role(scope, id, {
      roleName: `${options.prefix}-appconfig-fetcher-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add AppConfig permissions
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appconfig:StartConfigurationSession',
        'appconfig:GetConfiguration',
        'appconfig:GetLatestConfiguration',
      ],
      resources: [options.appConfigArn, `${options.appConfigArn}/*`],
    }));

    // Add S3 permissions for reading config files
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [options.configBucketArn, `${options.configBucketArn}/*`],
    }));

    return role;
  }

  /**
   * Creates a Lambda function for fetching AppConfig configurations
   */
  public static createAppConfigFetcherLambda(
    scope: Construct,
    id: string,
    options: {
      prefix: string;
      role: iam.Role;
      timeout?: cdk.Duration;
      memorySize?: number;
    }
  ): lambda.Function {
    return new lambda.Function(scope, id, {
      functionName: `${options.prefix}-appconfig-fetcher`,
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      role: options.role,
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          // Implementation for fetching AppConfig configuration
          console.log('Fetching AppConfig configuration', event);
          return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Configuration fetched successfully' }),
          };
        };
      `),
      timeout: options.timeout || cdk.Duration.seconds(10),
      memorySize: options.memorySize || 128,
    });
  }

  /**
   * Creates a KMS key with appropriate permissions for SageMaker operations
   */
  public static createEncryptionKey(
    scope: Construct,
    id: string,
    projectPrefix: string,
    options: {
      keyAdminPrincipals?: iam.IPrincipal[];
      keyUserPrincipals?: iam.IPrincipal[];
      enableKeyRotation?: boolean;
      removalPolicy?: cdk.RemovalPolicy;
    } = {}
  ): kms.Key {
    const key = new kms.Key(scope, id, {
      enableKeyRotation: options.enableKeyRotation ?? true,
      alias: `${projectPrefix}-${id}`,
      description: `KMS key for ${projectPrefix} ${id}`,
      removalPolicy: options.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });

    // Grant admin permissions to specified principals
    if (options.keyAdminPrincipals) {
      options.keyAdminPrincipals.forEach(principal => {
        key.grantAdmin(principal);
      });
    }

    // Grant usage permissions to specified principals
    if (options.keyUserPrincipals) {
      options.keyUserPrincipals.forEach(principal => {
        key.grantEncryptDecrypt(principal);
      });
    }

    return key;
  }

  /**
   * Creates a SageMaker specific policy
   */
  public static createSageMakerPolicy(
    scope: Construct,
    id: string,
    projectPrefix: string,
    options: {
      allowModelCreation?: boolean;
      allowEndpointCreation?: boolean;
      allowAutoScaling?: boolean;
      additionalPermissions?: string[];
    } = {}
  ): iam.ManagedPolicy {
    const policyDocument = new iam.PolicyDocument();
    const statements: iam.PolicyStatement[] = [];

    if (options.allowModelCreation) {
      statements.push(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateModel',
          'sagemaker:DeleteModel',
          'sagemaker:DescribeModel',
        ],
        resources: [`arn:aws:sagemaker:*:*:model/${projectPrefix}-*`],
      }));
    }

    if (options.allowEndpointCreation) {
      statements.push(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateEndpoint',
          'sagemaker:CreateEndpointConfig',
          'sagemaker:DeleteEndpoint',
          'sagemaker:DeleteEndpointConfig',
          'sagemaker:DescribeEndpoint',
          'sagemaker:DescribeEndpointConfig',
          'sagemaker:UpdateEndpoint',
          'sagemaker:UpdateEndpointWeightsAndCapacities',
        ],
        resources: [
          `arn:aws:sagemaker:*:*:endpoint/${projectPrefix}-*`,
          `arn:aws:sagemaker:*:*:endpoint-config/${projectPrefix}-*`,
        ],
      }));
    }

    if (options.allowAutoScaling) {
      statements.push(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'application-autoscaling:RegisterScalableTarget',
          'application-autoscaling:DescribeScalableTargets',
          'application-autoscaling:DeregisterScalableTarget',
          'application-autoscaling:PutScalingPolicy',
          'application-autoscaling:DescribeScalingPolicies',
          'application-autoscaling:DeleteScalingPolicy',
        ],
        resources: ['*'],
      }));

      statements.push(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricAlarm',
          'cloudwatch:DescribeAlarms',
          'cloudwatch:DeleteAlarms',
        ],
        resources: ['*'],
      }));
    }

    // Add additional permissions if specified
    if (options.additionalPermissions && options.additionalPermissions.length > 0) {
      statements.push(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: options.additionalPermissions,
        resources: ['*'],
      }));
    }

    statements.forEach(statement => policyDocument.addStatements(statement));

    return new iam.ManagedPolicy(scope, id, {
      managedPolicyName: `${projectPrefix}-${id}`,
      document: policyDocument,
    });
  }
}
