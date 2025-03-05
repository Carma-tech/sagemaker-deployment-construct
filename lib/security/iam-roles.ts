// lib/security/iam-roles.ts
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SageMakerExecutionRoleProps {
  readonly namePrefix: string;
  readonly modelArtifactBuckets: string[];
  readonly modelArtifactKeys: string[];
  readonly configBucket?: string;
  readonly configKey?: string;
  readonly kmsKey?: kms.IKey;
  readonly logsRetentionRole?: iam.IRole;
  readonly cloudwatchLogsEnabled?: boolean;
  readonly cloudwatchMetricsEnabled?: boolean;
  readonly appConfigEnabled?: boolean;
  readonly appConfigApplicationId?: string;
  readonly appConfigEnvironmentId?: string;
  readonly appConfigProfileId?: string;
  readonly vpcAccess?: boolean;
  readonly region?: string;
  readonly account?: string;
}

export class SageMakerExecutionRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SageMakerExecutionRoleProps) {
    super(scope, id);

    // Get region and account
    const region = props.region || cdk.Stack.of(this).region;
    const account = props.account || cdk.Stack.of(this).account;

    // Create execution role with assumed by policy for SageMaker
    this.role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: `Execution role for SageMaker model ${props.namePrefix}`,
      managedPolicies: [
        // This managed policy is too permissive for production use
        // We'll add specific permissions instead
        // iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')
      ],
    });

    // Add model artifact access - least privilege
    this.addModelArtifactPermissions(props, region, account);

    // Add AppConfig permissions if needed
    if (props.appConfigEnabled) {
      this.addAppConfigPermissions(props, region, account);
    }

    // Add CloudWatch permissions if needed
    if (props.cloudwatchLogsEnabled) {
      this.addCloudWatchLogsPermissions(region, account);
    }

    // Add CloudWatch Metrics permissions if needed
    if (props.cloudwatchMetricsEnabled) {
      this.addCloudWatchMetricsPermissions();
    }

    // Add KMS permissions if needed
    if (props.kmsKey) {
      this.addKmsPermissions(props);
    }

    // Add VPC access permissions if needed
    if (props.vpcAccess) {
      this.addVpcPermissions();
    }
  }

  private addModelArtifactPermissions(props: SageMakerExecutionRoleProps, region: string, account: string): void {
    // Add S3 permissions for model artifacts with least privilege
    for (let i = 0; i < props.modelArtifactBuckets.length; i++) {
      const bucketName = props.modelArtifactBuckets[i];
      const objectKey = props.modelArtifactKeys[i];

      // GetObject permission for specific artifact
      this.role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          `arn:aws:s3:::${bucketName}/${objectKey}`,
        ],
      }));

      // ListBucket permission with prefix condition to limit scope
      const prefix = this.getS3Prefix(objectKey);
      if (prefix) {
        this.role.addToPolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket'],
          resources: [`arn:aws:s3:::${bucketName}`],
          conditions: {
            StringLike: {
              's3:prefix': [prefix + '*'],
            },
          },
        }));
      }
    }

    // Add config bucket permissions if provided
    if (props.configBucket && props.configKey) {
      this.role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          `arn:aws:s3:::${props.configBucket}/${props.configKey}`,
        ],
      }));
    }
  }

  private getS3Prefix(objectKey: string): string | null {
    const parts = objectKey.split('/');
    if (parts.length <= 1) {
      return null;
    }
    
    // Return everything except the last part (filename)
    return parts.slice(0, parts.length - 1).join('/') + '/';
  }

  private addAppConfigPermissions(props: SageMakerExecutionRoleProps, region: string, account: string): void {
    // Add AppConfig permissions with least privilege
    const appConfigResources = [];
    
    if (props.appConfigApplicationId && props.appConfigEnvironmentId && props.appConfigProfileId) {
      // If we have specific IDs, use them for more restrictive permissions
      appConfigResources.push(
        `arn:aws:appconfig:${region}:${account}:application/${props.appConfigApplicationId}`,
        `arn:aws:appconfig:${region}:${account}:application/${props.appConfigApplicationId}/environment/${props.appConfigEnvironmentId}`,
        `arn:aws:appconfig:${region}:${account}:application/${props.appConfigApplicationId}/configurationprofile/${props.appConfigProfileId}`
      );
    } else {
      // Otherwise, use wildcard permission but limit to specific actions
      appConfigResources.push(`arn:aws:appconfig:${region}:${account}:*`);
    }

    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appconfig:StartConfigurationSession',
        'appconfig:GetLatestConfiguration',
      ],
      resources: appConfigResources,
    }));
  }

  private addCloudWatchLogsPermissions(region: string, account: string): void {
    // Add CloudWatch Logs permissions with least privilege
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/sagemaker/Endpoints/*`,
      ],
    }));
  }

  private addCloudWatchMetricsPermissions(): void {
    // Add CloudWatch Metrics permissions with least privilege
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': [
            'aws/sagemaker/Endpoints',
            'SageMaker/CustomMetrics',
          ],
        },
      },
    }));
  }

  private addKmsPermissions(props: SageMakerExecutionRoleProps): void {
    // Add KMS permissions if encryption is configured
    if (props.kmsKey) {
      this.role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: [props.kmsKey.keyArn],
      }));
    }
  }

  private addVpcPermissions(): void {
    // Add VPC permissions to allow SageMaker to create ENIs in VPC
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
      ],
      resources: ['*'],
      // For production, this could be scoped down to specific VPC resources
    }));
  }
}