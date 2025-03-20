/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

export class SecurityOperationalEnhancementsStack extends BaseStack {
  public readonly encryptionKey: kms.Key;
  public readonly enhancedBucket: s3.Bucket;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);

    // -----------------------------------------------------
    // Step 6: Security and Compliance Enhancements
    // -----------------------------------------------------

    // 1. Create a KMS key with key rotation enabled.
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      enableKeyRotation: true,
      alias: `${this.projectPrefix}-EncryptionKey`,
      description: 'KMS key for encrypting S3 buckets and sensitive data',
    });

    // 2. Create an S3 bucket with encryption enforced using the KMS key.
    this.enhancedBucket = new s3.Bucket(this, 'EnhancedBucket', {
      bucketName: `${this.projectPrefix}-${stackConfig.BucketBaseName}`.toLowerCase().replace('_', '-'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Change to DESTROY if you prefer auto cleanup
      autoDeleteObjects: false,
    });

    new cdk.CfnOutput(this, 'EnhancedBucketName', {
      value: this.enhancedBucket.bucketName,
      description: 'Enhanced S3 Bucket with KMS encryption',
    });

    // 3. Create a dedicated IAM role for secure access to AWS AppConfig and CloudWatch Logs.
    const secureConfigRole = new iam.Role(this, 'SecureConfigRole', {
      roleName: `${this.projectPrefix}-SecureConfigRole`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), // Adjust principal as needed.
    });

    // Policy for secure access to AWS AppConfig configurations.
    secureConfigRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:GetConfiguration',
        'appconfig:StartConfigurationSession',
      ],
      resources: ['*'], // Consider restricting to specific AppConfig resources.
      effect: iam.Effect.ALLOW,
    }));

    // Policy for secure CloudWatch Logs access.
    secureConfigRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['arn:aws:logs:*:*:*'],
      effect: iam.Effect.ALLOW,
    }));

    // -----------------------------------------------------
    // Step 7: Operational Enhancements
    // -----------------------------------------------------

    // Assume that the SageMaker endpoint name has been stored in SSM by a serving stack.
    const endpointName = this.getParameter('sageMakerEndpointName');

    // If auto scaling is enabled in your configuration, set up Application Auto Scaling for the SageMaker endpoint.
    if (endpointName && stackConfig.AutoScalingEnable) {
      const scalableTarget = new appscaling.ScalableTarget(this, 'SageMakerEndpointScalableTarget', {
        serviceNamespace: appscaling.ServiceNamespace.SAGEMAKER,
        maxCapacity: stackConfig.AutoScalingMaxCapacity || 2,
        minCapacity: stackConfig.AutoScalingMinCapacity || 1,
        resourceId: `endpoint/${endpointName}`,
        scalableDimension: 'sagemaker:variant:DesiredInstanceCount',
      });

      scalableTarget.scaleToTrackMetric('SageMakerScalingPolicy', {
        targetValue: stackConfig.AutoScalingTargetInvocation || 50,
        predefinedMetric: appscaling.PredefinedMetric.SAGEMAKER_VARIANT_INVOCATIONS_PER_INSTANCE,
        scaleInCooldown: cdk.Duration.seconds(300),
        scaleOutCooldown: cdk.Duration.seconds(300),
      });
    }

    // Operational logging enhancements:
    // Any Lambda or other resource that requires enhanced logging can assume the secureConfigRole
    // or be granted similar permissions.

    // You may also implement further operational enhancements such as:
    // - Rolling updates via Blue/Green deployment strategies (using AWS CodeDeploy)
    // - Versioning and automated redeployment triggers (via CloudWatch Events or Step Functions)
    // These are highly use-case specific and can be integrated with your CI/CD pipeline.

    // Output the encryption key ARN for reference.
    new cdk.CfnOutput(this, 'EncryptionKeyARN', {
      value: this.encryptionKey.keyArn,
      description: 'ARN of the KMS encryption key',
    });
  }
}
