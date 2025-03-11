import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * Properties for SageMaker Deployment construct
 */
export interface SageMakerDeploymentProps {
  /**
   * Name of the model
   */
  readonly modelName: string;

  /**
   * Optional description of the model
   */
  readonly description?: string;

  /**
   * Deployment strategy for the model
   */
  readonly deploymentStrategy: 'SINGLE_MODEL' | 'MULTI_VARIANT';

  /**
   * S3 location of the model artifacts
   */
  readonly modelArtifacts: {
    readonly bucketName: string;
    readonly objectKey: string;
  };

  /**
   * SageMaker instance type to use for the endpoint
   */
  readonly instanceType: string;

  /**
   * Initial number of instances to provision
   */
  readonly initialInstanceCount: number;

  /**
   * Optional auto-scaling configuration
   */
  readonly autoScaling?: {
    readonly minInstanceCount: number;
    readonly maxInstanceCount: number;
    readonly targetUtilization: number;
  };

  /**
   * AppConfig configuration for dynamic model configuration
   */
  readonly appConfig: {
    readonly applicationName: string;
    readonly environmentName: string;
    readonly configurationProfileName: string;
    readonly configBucket: string;
    readonly configKey: string;
  };

  /**
   * Optional monitoring configuration
   */
  readonly monitoring?: {
    readonly dataQualityEnabled?: boolean;
    readonly modelQualityEnabled?: boolean;
    readonly scheduleExpression?: string;
  };

  /**
   * Optional security configuration
   */
  readonly vpc?: ec2.IVpc;
  readonly securityGroups?: ec2.ISecurityGroup[];
  readonly kmsKey?: kms.IKey;
  readonly enableNetworkIsolation?: boolean;

  /**
   * Optional tags to apply to all resources
   */
  readonly tags?: { [key: string]: string };
}

/**
 * Construct for deploying SageMaker models with integrated configuration management and monitoring
 */
export class SageMakerDeployment extends Construct {
  // Public properties
  public readonly endpoint: sagemaker.CfnEndpoint;
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;
  public readonly model: sagemaker.CfnModel | sagemaker.CfnModel[];
  public readonly executionRole: iam.Role;
  public readonly dashboard: cloudwatch.Dashboard;

  // Private properties
  private readonly props: SageMakerDeploymentProps;

  /**
   * @param scope The parent construct
   * @param id The construct ID
   * @param props The construct properties
   */
  constructor(scope: Construct, id: string, props: SageMakerDeploymentProps) {
    super(scope, id);

    // Validate and store props
    this.props = this.validateProps(props);

    // Create the execution role for SageMaker
    this.executionRole = this.createExecutionRole();

    // Create the model and endpoint resources
    const resources = this.createModelResources();
    this.model = resources.model;
    this.endpointConfig = resources.endpointConfig;
    this.endpoint = resources.endpoint;

    // Set up AppConfig integration
    this.setupAppConfigIntegration();

    // Set up monitoring and dashboard
    this.setupMonitoring();
    this.dashboard = this.createDashboard();

    // Apply tags to all resources
    this.applyTags();
  }

  /**
   * Validates the construct properties
   * @param props The properties to validate
   * @returns The validated properties
   */
  private validateProps(props: SageMakerDeploymentProps): SageMakerDeploymentProps {
    // Required properties validation
    if (!props.modelName) {
      throw new Error('modelName is required');
    }

    if (!props.modelArtifacts || !props.modelArtifacts.bucketName || !props.modelArtifacts.objectKey) {
      throw new Error('modelArtifacts.bucketName and modelArtifacts.objectKey are required');
    }

    if (!props.instanceType) {
      throw new Error('instanceType is required');
    }

    if (props.initialInstanceCount === undefined) {
      throw new Error('initialInstanceCount is required');
    }

    if (props.initialInstanceCount < 1) {
      throw new Error('initialInstanceCount must be at least 1');
    }

    if (!props.appConfig) {
      throw new Error('appConfig is required for dynamic configuration');
    }

    // Auto-scaling validation
    if (props.autoScaling) {
      if (props.autoScaling.minInstanceCount < 1) {
        throw new Error('autoScaling.minInstanceCount must be at least 1');
      }

      if (props.autoScaling.maxInstanceCount < props.autoScaling.minInstanceCount) {
        throw new Error('autoScaling.maxInstanceCount must be greater than or equal to autoScaling.minInstanceCount');
      }

      if (props.autoScaling.targetUtilization <= 0 || props.autoScaling.targetUtilization > 100) {
        throw new Error('autoScaling.targetUtilization must be between 1 and 100');
      }
    }

    // VPC validation
    if (props.vpc && (!props.securityGroups || props.securityGroups.length === 0)) {
      throw new Error('securityGroups must be provided when vpc is specified');
    }

    return props;
  }

  /**
   * Creates the IAM execution role for SageMaker
   * @returns The created IAM role
   */
  private createExecutionRole(): iam.Role {
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: `Execution role for SageMaker model ${this.props.modelName}`,
    });

    // Add S3 permissions for model artifacts with broader access
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject',
        's3:ListBucket'
      ],
      resources: [
        `arn:aws:s3:::${this.props.modelArtifacts.bucketName}`,
        `arn:aws:s3:::${this.props.modelArtifacts.bucketName}/*`, // Use wildcard to cover all paths
      ],
    }));

    // Add broader S3 access for AppConfig configuration
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject',
        's3:ListBucket'
      ],
      resources: [
        `arn:aws:s3:::${this.props.appConfig.configBucket}`,
        `arn:aws:s3:::${this.props.appConfig.configBucket}/*`, // Use wildcard to cover all paths
      ],
    }));

    // Add ECR permissions
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage'
      ],
      resources: ['*'],
    }));

    // Grant ECR authorization
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Add AppConfig permissions
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:GetConfiguration',
        'appconfig:StartConfigurationSession',
      ],
      resources: ['*'],
    }));

    // Add CloudWatch permissions
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));

    // Add KMS permissions if encryption is configured
    if (this.props.kmsKey) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: [this.props.kmsKey.keyArn],
      }));
    }

    return role;
  }

  /**
   * Creates the SageMaker model and endpoint resources
   * @returns The created model, endpoint config, and endpoint
   */
  private createModelResources(): {
    model: sagemaker.CfnModel | sagemaker.CfnModel[];
    endpointConfig: sagemaker.CfnEndpointConfig;
    endpoint: sagemaker.CfnEndpoint;
  } {
    // For now, implement a simple version that will be expanded based on deployment strategy
    // This will be replaced by the strategy pattern implementation

    // Get the container image URI
    const containerImageUri = this.getContainerImage();

    // Log the image URI for debugging
    console.log(`Using container image URI: ${containerImageUri}`);

    // Create model
    const model = new sagemaker.CfnModel(this, 'Model', {
      executionRoleArn: this.executionRole.roleArn,
      primaryContainer: {
        modelDataUrl: `s3://${this.props.modelArtifacts.bucketName}/${this.props.modelArtifacts.objectKey}`,
        image: this.getContainerImage(),
        environment: {
          // Environment variables for AppConfig integration
          APPCONFIG_APPLICATION: this.props.appConfig.applicationName,
          APPCONFIG_ENVIRONMENT: this.props.appConfig.environmentName,
          APPCONFIG_PROFILE: this.props.appConfig.configurationProfileName,
        },
      },
      modelName: this.props.modelName,
      vpcConfig: this.getVpcConfig(),
      enableNetworkIsolation: this.props.enableNetworkIsolation ?? false,
    });

    // Create endpoint config
    const endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: [
        {
          initialVariantWeight: 1.0,
          modelName: model.attrModelName,
          variantName: 'DefaultVariant',
          initialInstanceCount: this.props.initialInstanceCount,
          instanceType: this.props.instanceType,
        },
      ],
    });

    // Create endpoint
    const endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointConfigName: endpointConfig.attrEndpointConfigName,
      endpointName: `${this.props.modelName}-endpoint`,
    });

    return {
      model,
      endpointConfig,
      endpoint,
    };
  }

  /**
   * Sets up the integration with AWS AppConfig
   */
  private setupAppConfigIntegration(): void {
    // This will be implemented in the next step
    // Placeholder for now to maintain the structure
  }

  /**
   * Sets up monitoring for the SageMaker endpoint
   */
  private setupMonitoring(): void {
    // This will be implemented in the monitoring step
    // Placeholder for now to maintain the structure
  }

  /**
   * Creates a CloudWatch dashboard for the SageMaker endpoint
   * @returns The created dashboard
   */
  private createDashboard(): cloudwatch.Dashboard {
    // This will be implemented in the monitoring step
    // Placeholder for now to maintain the structure
    return new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `SageMaker-${this.props.modelName}-Dashboard`,
    });
  }

  /**
   * Applies tags to all resources created by this construct
   */
  private applyTags(): void {
    // Convert the tags object to cdk.Tags
    if (this.props.tags) {
      const tags = cdk.Tags.of(this);

      for (const [key, value] of Object.entries(this.props.tags)) {
        tags.add(key, value);
      }
    }

    // Add default tags
    const tags = cdk.Tags.of(this);
    tags.add('ManagedBy', 'SageMakerDeploymentConstruct');
    tags.add('ModelName', this.props.modelName);
    tags.add('DeploymentStrategy', this.props.deploymentStrategy);
  }

  /**
   * Gets the container image URI for the model
   * @returns The container image URI
   */
  private getContainerImage(): string {
    // This would be replaced with actual container image selection logic
    // based on framework, region, etc.
    // Placeholder for now
    const region = cdk.Stack.of(this).region;
    return `763104351884.dkr.ecr.${region}.amazonaws.com/pytorch-inference:2.5.1-cpu-py311-ubuntu22.04-sagemaker`;
  }

  /**
   * Gets the VPC configuration for the model
   * @returns The VPC configuration or undefined if not configured
   */
  private getVpcConfig() {
    if (!this.props.vpc || !this.props.securityGroups || this.props.securityGroups.length === 0) {
      return undefined;
    }

    return {
      securityGroupIds: this.props.securityGroups.map(sg => sg.securityGroupId),
      subnets: this.props.vpc.privateSubnets.map(subnet => subnet.subnetId),
    };
  }
}