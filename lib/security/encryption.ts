// lib/security/encryption.ts
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface EncryptionConfigProps {
  readonly namePrefix: string;
  readonly createKey?: boolean;
  readonly existingKeyId?: string;
  readonly keyAlias?: string;
  readonly keyDescription?: string;
  readonly keyAdminRoleArns?: string[];
  readonly keyUserRoleArns?: string[];
  readonly enableKeyRotation?: boolean;
  readonly endpointEncryptionEnabled?: boolean;
  readonly volumeEncryptionEnabled?: boolean;
}

export class EncryptionConfig extends Construct {
  public readonly kmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: EncryptionConfigProps) {
    super(scope, id);

    // Either create a new KMS key or import an existing one
    if (props.createKey) {
      this.kmsKey = this.createKmsKey(props);
    } else if (props.existingKeyId) {
      this.kmsKey = kms.Key.fromKeyArn(this, 'ImportedKey', 
        `arn:aws:kms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:key/${props.existingKeyId}`);
    } else {
      // If neither is provided, create a new key by default
      this.kmsKey = this.createKmsKey(props);
    }
  }

  private createKmsKey(props: EncryptionConfigProps): kms.Key {
    // Create a new KMS key for encryption
    const key = new kms.Key(this, 'EncryptionKey', {
      description: props.keyDescription || `KMS key for SageMaker deployment ${props.namePrefix}`,
      alias: props.keyAlias || `alias/${props.namePrefix}-sagemaker-key`,
      enableKeyRotation: props.enableKeyRotation !== false, // Enable rotation by default
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Don't delete the key when the stack is deleted
    });

    // Add admin permissions
    if (props.keyAdminRoleArns && props.keyAdminRoleArns.length > 0) {
      props.keyAdminRoleArns.forEach((roleArn, index) => {
        const adminPrincipal = new cdk.aws_iam.ArnPrincipal(roleArn);
        key.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
          sid: `AllowKeyAdministration${index}`,
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [adminPrincipal],
          actions: [
            'kms:Create*',
            'kms:Describe*',
            'kms:Enable*',
            'kms:List*',
            'kms:Put*',
            'kms:Update*',
            'kms:Revoke*',
            'kms:Disable*',
            'kms:Get*',
            'kms:Delete*',
            'kms:ScheduleKeyDeletion',
            'kms:CancelKeyDeletion',
          ],
          resources: ['*'],
        }));
      });
    }

    // Add user permissions
    if (props.keyUserRoleArns && props.keyUserRoleArns.length > 0) {
      props.keyUserRoleArns.forEach((roleArn, index) => {
        const userPrincipal = new cdk.aws_iam.ArnPrincipal(roleArn);
        key.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
          sid: `AllowKeyUsage${index}`,
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [userPrincipal],
          actions: [
            'kms:Encrypt',
            'kms:Decrypt',
            'kms:ReEncrypt*',
            'kms:GenerateDataKey*',
            'kms:DescribeKey',
          ],
          resources: ['*'],
        }));
      });
    }

    // Allow SageMaker service to use the key
    key.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      sid: 'AllowSageMakerService',
      effect: cdk.aws_iam.Effect.ALLOW,
      principals: [new cdk.aws_iam.ServicePrincipal('sagemaker.amazonaws.com')],
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:DescribeKey',
      ],
      resources: ['*'],
    }));

    return key;
  }

  // Helper method to apply encryption to a SageMaker endpoint config
  public applyEndpointEncryption(endpointConfig: sagemaker.CfnEndpointConfig): void {
    // Apply KMS encryption to the endpoint
    const cfnEndpointConfig = endpointConfig as sagemaker.CfnEndpointConfig;
    cfnEndpointConfig.kmsKeyId = this.kmsKey.keyId;
  }

  // Helper method to apply volume encryption to a SageMaker model
public applyVolumeEncryption(model: sagemaker.CfnModel): void {
    // Apply KMS encryption to the model's container volumes
    const cfnModel = model as sagemaker.CfnModel;
    
    // Handle primary container
    if (cfnModel.primaryContainer) {
      // Since primaryContainer could be IResolvable, we need to check its type
      const container = cfnModel.primaryContainer;
      if (!cdk.Token.isUnresolved(container) && typeof container === 'object') {
        // Create or update modelDataConfig
        // Update the model data config with the KMS key
        cfnModel.addPropertyOverride('PrimaryContainer.ModelDataUrl.KmsKeyId', this.kmsKey.keyId);
      }
    }
    
    // Handle multiple containers
    if (cfnModel.containers) {
      // Check if containers is a resolvable token or an array
      if (!cdk.Token.isUnresolved(cfnModel.containers) && Array.isArray(cfnModel.containers)) {
        // Process each container
        cfnModel.containers.forEach((container, index) => {
          if (!cdk.Token.isUnresolved(container) && typeof container === 'object') {
            // Update with property override to avoid type issues
            cfnModel.addPropertyOverride(`Containers.${index}.ModelDataConfig.KmsKeyId`, this.kmsKey.keyId);
          }
        });
      }
    }
  }

  // Helper method to apply encryption to an S3 bucket
  public static applyBucketEncryption(bucket: s3.IBucket, kmsKey: kms.IKey): void {
    if (bucket instanceof s3.Bucket) {
      // If this is a bucket we created (not imported), we can configure encryption
      const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;
      cfnBucket.bucketEncryption = {
        serverSideEncryptionConfiguration: [
          {
            serverSideEncryptionByDefault: {
              sseAlgorithm: 'aws:kms',
              kmsMasterKeyId: kmsKey.keyId,
            },
          },
        ],
      };
    }
  }
}