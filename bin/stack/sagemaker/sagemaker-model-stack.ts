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

    // Create an execution role that inherits from the base role
    this.executionRole = new iam.Role(this, 'ModelExecutionRole', {
      roleName: `${this.projectPrefix}-model-execution-role`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
    });

    // Add permissions from base role
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sts:AssumeRole'
      ],
      resources: [stackConfig.baseRole.roleArn]
    }));

    // Add model-specific permissions
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sagemaker:CreateModel',
        'sagemaker:DeleteModel',
        'sagemaker:DescribeModel',
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage'
      ],
      resources: ['*']
    }));

    // Grant KMS permissions
    stackConfig.encryptionKey.grantDecrypt(this.executionRole);

    const s3ArtifactKey: string = 'models/model/model.tar.gz'
    // Create SageMaker models from configuration
    for (const modelConfig of stackConfig.models) {
      const model = new sagemaker.CfnModel(this, `Model-${modelConfig.modelName}`, {
        modelName: `${this.projectPrefix}-${modelConfig.modelName}`,
        executionRoleArn: this.executionRole.roleArn,
        primaryContainer: {
          image: modelConfig.image,
          modelDataUrl: s3ArtifactKey || `s3://${stackConfig.modelArtifactBucket.bucketName}/${modelConfig.artifactKey}`,
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
        value: model.attrId,
        exportName: `${this.projectPrefix}-model-${name}-arn`
      });
    });
  }
}