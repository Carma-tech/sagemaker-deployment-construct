import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { join } from 'path';
import * as fs from 'fs';

interface SageMakerBaseInfraStackProps {
  Name: string;
  EnableEncryption?: boolean;
  EnableVersioning?: boolean;
  TestMode?: boolean;
}

export class SageMakerBaseInfraStack extends BaseStack {
  public readonly modelArtifactBucket: s3.IBucket;
  public readonly configBucket: s3.IBucket;
  public readonly sagemakerBaseRole: iam.IRole;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: SageMakerBaseInfraStackProps) {
    super(scope, stackConfig.Name, props, stackConfig);

    this.encryptionKey = stackConfig.EnableEncryption
      ? new kms.Key(this, 'EncryptionKey', {
        alias: `${this.projectPrefix}-key`,
        description: 'KMS key for SageMaker resources encryption',
        enableKeyRotation: true,
      })
      : kms.Key.fromKeyArn(this, 'DefaultEncryptionKey', `arn:aws:kms:${this.region}:${this.account}:alias/aws/s3`);

    let modelArtifactBucketName, configBucketName;

    if (stackConfig.TestMode) {
      modelArtifactBucketName = `${this.projectPrefix}-model-artifacts`;
      configBucketName = `${this.projectPrefix}-configs`;
    } else {
      modelArtifactBucketName = `${this.projectPrefix}-model-artifacts-bucket`.toLowerCase();
      configBucketName = `${this.projectPrefix}-configs-bucket`.toLowerCase();
    }

    this.modelArtifactBucket = new s3.Bucket(this, 'ModelArtifactBucket', {
      bucketName: modelArtifactBucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: stackConfig.EnableVersioning || false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: configBucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: stackConfig.EnableVersioning || false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Deploy config files from the config directory if it exists
    const configDirPath = join(__dirname, '../../../config');
    if (fs.existsSync(configDirPath)) {
      try {
        new BucketDeployment(this, 'DeployConfigFiles', {
          sources: [Source.asset(configDirPath)],
          destinationBucket: this.configBucket,
          destinationKeyPrefix: 'config'
        });
        console.log(`Deployed configuration files from ${configDirPath} to S3`);
      } catch (error) {
        console.warn(`Failed to deploy config files: ${error}`);
      }
    }

    // Deploy model artifact if exists
    if (fs.existsSync(join(__dirname, '../../../models/model-a/model/model.tar.gz'))) {
      new BucketDeployment(this, 'DeployModelFiles', {
        sources: [Source.asset(join(__dirname, '../../../models/model-a/model'))],
        destinationBucket: this.modelArtifactBucket,
        destinationKeyPrefix: 'models/text-classification'
      });
    }

    this.sagemakerBaseRole = new iam.Role(this, 'SageMakerBaseRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      roleName: `${this.projectPrefix}-sagemaker-base-role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')
      ]
    });

    this.modelArtifactBucket.grantReadWrite(this.sagemakerBaseRole);
    this.configBucket.grantReadWrite(this.sagemakerBaseRole);

    this.encryptionKey.grantEncryptDecrypt(this.sagemakerBaseRole);

    new cdk.CfnOutput(this, 'ModelArtifactBucketName', {
      value: this.modelArtifactBucket.bucketName,
      exportName: `${this.projectPrefix}-model-artifact-bucket-name`
    });

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.configBucket.bucketName,
      exportName: `${this.projectPrefix}-config-bucket-name`
    });

    new cdk.CfnOutput(this, 'SageMakerBaseRoleArn', {
      value: this.sagemakerBaseRole.roleArn,
      exportName: `${this.projectPrefix}-sagemaker-base-role-arn`
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      exportName: `${this.projectPrefix}-encryption-key-arn`
    });
  }
}