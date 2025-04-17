import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface SageMakerModelStackProps {
  Name?: string;
  modelArtifactBucket: s3.IBucket;
  baseRole: iam.IRole;
  encryptionKey: kms.IKey;
  models: Array<{
    modelName: string;
    artifactKey: string;
    image: string;
    environment?: { [key: string]: string };
  }>;
}

export class SageMakerModelStack extends BaseStack {
  public readonly models: Map<string, sagemaker.CfnModel>;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: SageMakerModelStackProps) {
    super(scope, 'SageMakerModelStack', props, stackConfig);

    this.models = new Map();

    // Create an execution role for SageMaker with explicit permissions
    this.executionRole = new iam.Role(this, 'ModelExecutionRole', {
      roleName: `${this.projectPrefix}-model-execution-role`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        // Add the AmazonSageMakerFullAccess managed policy
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')
      ]
    });

    // Add direct S3 permissions to access model artifacts (instead of assuming base role)
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
        's3:GetBucketLocation'
      ],
      resources: [
        stackConfig.modelArtifactBucket.bucketArn,
        `${stackConfig.modelArtifactBucket.bucketArn}/*`
      ]
    }));

    // Grant the execution role permission to use the KMS key for bucket encryption
    stackConfig.encryptionKey.grantDecrypt(this.executionRole);

    // Grant explicit access to the model artifact bucket
    stackConfig.modelArtifactBucket.grantRead(this.executionRole);

    // Create SageMaker models from configuration
    for (const modelConfig of stackConfig.models) {
      // Determine the model artifact path dynamically
      // First check if artifactKey is provided from the model config
      // Default to a standard path if not specified
      const modelArtifactPath = modelConfig.artifactKey || 'models/model-a/model/model.tar.gz';
      
      // Ensure the path starts with 'models/' as the root folder
      const normalizedPath = modelArtifactPath.startsWith('models/') 
        ? modelArtifactPath 
        : `models/${modelArtifactPath}`;
        
      // Create a properly formatted S3 URL for the model artifact
      const modelDataUrl = `s3://${stackConfig.modelArtifactBucket.bucketName}/${normalizedPath}`;
      
      console.log(`Creating model ${modelConfig.modelName} with artifact at: ${modelDataUrl}`);
      
      const model = new sagemaker.CfnModel(this, `Model-${modelConfig.modelName}`, {
        modelName: `${this.projectPrefix}-${modelConfig.modelName}`,
        executionRoleArn: this.executionRole.roleArn,
        primaryContainer: {
          image: modelConfig.image,
          modelDataUrl: modelDataUrl,
          environment: {
            MODEL_SERVER_TIMEOUT: '3600',
            ...modelConfig.environment
          }
        },
        enableNetworkIsolation: true, // Security best practice
        tags: [
          {
            key: 'Project',
            value: this.projectPrefix
          },
          {
            key: 'ModelName',
            value: modelConfig.modelName
          }
        ]
      });

      this.models.set(modelConfig.modelName, model);
    }

    // Export role ARN for other stacks
    new cdk.CfnOutput(this, 'ModelExecutionRoleArn', {
      value: this.executionRole.roleArn,
      exportName: `${this.projectPrefix}-model-execution-role-arn`
    });

    // Export model names and ARNs
    this.models.forEach((model, name) => {
      new cdk.CfnOutput(this, `Model${name}Arn`, {
        value: model.ref,  // Use 'ref' which returns the model ARN
        exportName: `${this.projectPrefix}-model-${name}-arn`
      });
    });
  }
}