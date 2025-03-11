import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

// Base interface for model artifacts
export interface ModelArtifact {
  readonly bucketName: string;
  readonly objectKey: string;
}

// Interface for model variant configuration
export interface ModelVariant {
  readonly variantName: string;
  readonly modelArtifacts: ModelArtifact;
  readonly initialInstanceCount: number;
  readonly instanceType: string;
  readonly initialVariantWeight: number;
}

// Main props interface for the construct
export interface SageMakerModelServingProps {
  // General configuration
  readonly modelName: string;
  readonly description?: string;
  readonly tags?: { [key: string]: string };
  
  // Deployment strategy configuration
  readonly deploymentStrategy: 'SINGLE_MODEL' | 'MULTI_VARIANT';
  
  // For single model deployment
  readonly modelArtifact?: ModelArtifact;
  
  // For multi-variant deployment
  readonly modelVariants?: ModelVariant[];
  
  // Instance configuration
  readonly instanceType?: string;
  readonly initialInstanceCount?: number;
  readonly autoScaling?: {
    readonly minInstanceCount: number;
    readonly maxInstanceCount: number;
    readonly targetUtilization: number;
  };
  
  // AppConfig configuration
  readonly appConfig: {
    readonly applicationName: string;
    readonly environmentName: string;
    readonly configurationProfileName: string;
    readonly configBucket: string;
    readonly configKey: string;
  };
  
  // Monitoring configuration
  readonly monitoring?: {
    readonly dataQualityEnabled?: boolean;
    readonly modelQualityEnabled?: boolean;
    readonly biasEnabled?: boolean;
    readonly explainabilityEnabled?: boolean;
    readonly scheduleExpression?: string;
  };
  
  // Security configuration
  readonly vpc?: ec2.IVpc;
  readonly securityGroups?: ec2.ISecurityGroup[];
  readonly kmsKey?: kms.IKey;
  readonly enableNetworkIsolation?: boolean;
}

/**
 * SageMaker Model Serving Construct
 * 
 * This construct creates SageMaker resources for model deployment with either:
 * - Single model endpoint
 * - Multiple model variants under one endpoint
 * 
 * It integrates with AWS AppConfig for dynamic configuration and
 * provides monitoring and security capabilities.
 */
export class SageMakerModelServing extends Construct {
  // Public properties
  public readonly models: sagemaker.CfnModel[] = [];
  public endpointConfig: sagemaker.CfnEndpointConfig;
  public endpoint: sagemaker.CfnEndpoint;
  public readonly executionRole: iam.Role;
  public readonly monitoringSchedules: sagemaker.CfnMonitoringSchedule[] = [];
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly appConfigApplication: appconfig.CfnApplication;
  public readonly appConfigEnvironment: appconfig.CfnEnvironment;
  public readonly appConfigConfigurationProfile: appconfig.CfnConfigurationProfile;
  
  constructor(scope: Construct, id: string, props: SageMakerModelServingProps) {
    super(scope, id);
    
    // Validate props based on deployment strategy
    this.validateProps(props);
    
    // Create IAM execution role
    this.executionRole = this.createExecutionRole(props);
    
    // Set up AppConfig resources
    const appConfigResources = this.setupAppConfig(props);
    this.appConfigApplication = appConfigResources.application;
    this.appConfigEnvironment = appConfigResources.environment;
    this.appConfigConfigurationProfile = appConfigResources.configurationProfile;
    
    // Deploy SageMaker resources based on strategy
    if (props.deploymentStrategy === 'SINGLE_MODEL') {
      this.deploySingleModel(props);
    } else {
      this.deployMultiVariant(props);
    }
    
    // Set up monitoring
    this.setupMonitoring(props);
    
    // Create dashboard
    this.dashboard = this.createDashboard(props);
    
    // Apply tags to all resources
    this.applyTags(props);
  }
  
  /**
   * Validates input props based on deployment strategy
   */
  private validateProps(props: SageMakerModelServingProps): void {
    if (!props.modelName) {
      throw new Error('modelName is required');
    }
    
    if (!props.appConfig || !props.appConfig.applicationName || !props.appConfig.environmentName) {
      throw new Error('AppConfig configuration is required');
    }
    
    if (props.deploymentStrategy === 'SINGLE_MODEL') {
      if (!props.modelArtifact || !props.modelArtifact.bucketName || !props.modelArtifact.objectKey) {
        throw new Error('modelArtifact is required for SINGLE_MODEL deployment strategy');
      }
      
      if (!props.instanceType || !props.initialInstanceCount) {
        throw new Error('instanceType and initialInstanceCount are required for SINGLE_MODEL deployment');
      }
    } else if (props.deploymentStrategy === 'MULTI_VARIANT') {
      if (!props.modelVariants || props.modelVariants.length === 0) {
        throw new Error('modelVariants is required for MULTI_VARIANT deployment strategy');
      }
      
      // Ensure each variant has required properties
      props.modelVariants.forEach((variant, index) => {
        if (!variant.variantName) {
          throw new Error(`Variant at index ${index} is missing variantName`);
        }
        if (!variant.modelArtifacts || !variant.modelArtifacts.bucketName || !variant.modelArtifacts.objectKey) {
          throw new Error(`Variant ${variant.variantName} is missing modelArtifacts`);
        }
        if (!variant.instanceType || !variant.initialInstanceCount) {
          throw new Error(`Variant ${variant.variantName} is missing instanceType or initialInstanceCount`);
        }
      });
    } else {
      throw new Error(`Unsupported deployment strategy: ${props.deploymentStrategy}`);
    }
  }
  
  /**
   * Creates the IAM execution role for SageMaker
   */
  private createExecutionRole(props: SageMakerModelServingProps): iam.Role {
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: `Execution role for SageMaker model ${props.modelName}`,
    });
    
    // Add S3 permissions for model artifacts
    const s3Resources: string[] = [];
    
    if (props.deploymentStrategy === 'SINGLE_MODEL' && props.modelArtifact) {
      s3Resources.push(
        `arn:aws:s3:::${props.modelArtifact.bucketName}`,
        `arn:aws:s3:::${props.modelArtifact.bucketName}/${props.modelArtifact.objectKey}`
      );
    } else if (props.deploymentStrategy === 'MULTI_VARIANT' && props.modelVariants) {
      props.modelVariants.forEach(variant => {
        s3Resources.push(
          `arn:aws:s3:::${variant.modelArtifacts.bucketName}`,
          `arn:aws:s3:::${variant.modelArtifacts.bucketName}/${variant.modelArtifacts.objectKey}`
        );
      });
    }
    
    // Add S3 policy for model artifacts
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: s3Resources,
    }));
    
    // Add S3 policy for AppConfig configuration
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${props.appConfig.configBucket}`,
        `arn:aws:s3:::${props.appConfig.configBucket}/${props.appConfig.configKey}`
      ],
    }));
    
    // Add AppConfig permissions
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:GetConfiguration',
        'appconfig:StartConfigurationSession',
      ],
      resources: ['*'], // Will be restricted to specific AppConfig resources later
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
    
    // Add KMS permissions if encryption is used
    if (props.kmsKey) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: [
          'kms:Decrypt',
          'kms:GenerateDataKey',
        ],
        resources: [props.kmsKey.keyArn],
      }));
    }
    
    return role;
  }
  
  /**
   * Sets up AWS AppConfig resources
   */
  private setupAppConfig(props: SageMakerModelServingProps) {
    // Create AppConfig Application
    const application = new appconfig.CfnApplication(this, 'Application', {
      name: props.appConfig.applicationName,
      description: `AppConfig application for ${props.modelName}`,
    });
    
    // Create AppConfig Environment
    const environment = new appconfig.CfnEnvironment(this, 'Environment', {
      applicationId: application.ref,
      name: props.appConfig.environmentName,
      description: `Environment for ${props.modelName}`,
    });
    
    // Create AppConfig Configuration Profile
    const configurationProfile = new appconfig.CfnConfigurationProfile(this, 'ConfigurationProfile', {
      applicationId: application.ref,
      name: props.appConfig.configurationProfileName,
      locationUri: `s3://${props.appConfig.configBucket}/${props.appConfig.configKey}`,
      type: 'AWS.Freeform',
      validators: [
        {
          type: 'JSON_SCHEMA',
          content: JSON.stringify({
            type: 'object',
            required: ['version'],
            properties: {
              version: { type: 'string' },
              parameters: { type: 'object' }
            }
          })
        }
      ],
    });
    
    // Create initial deployment
    new appconfig.CfnDeployment(this, 'InitialDeployment', {
      applicationId: application.ref,
      environmentId: environment.ref,
      configurationProfileId: configurationProfile.ref,
      configurationVersion: '1',
      deploymentStrategyId: 'AppConfig.AllAtOnce',
    });
    
    return {
      application,
      environment,
      configurationProfile,
    };
  }
  
  /**
   * Deploys a single model endpoint
   */
  private deploySingleModel(props: SageMakerModelServingProps): void {
    if (!props.modelArtifact || !props.instanceType || !props.initialInstanceCount) {
      throw new Error('modelArtifact, instanceType, and initialInstanceCount are required for single model deployment');
    }
    
    // Create the SageMaker model
    const model = new sagemaker.CfnModel(this, 'Model', {
      executionRoleArn: this.executionRole.roleArn,
      primaryContainer: {
        modelDataUrl: `s3://${props.modelArtifact.bucketName}/${props.modelArtifact.objectKey}`,
        image: this.getContainerImage(props),
        environment: {
          // Environment variables for AppConfig integration
          APPCONFIG_APPLICATION: props.appConfig.applicationName,
          APPCONFIG_ENVIRONMENT: props.appConfig.environmentName,
          APPCONFIG_PROFILE: props.appConfig.configurationProfileName,
        },
      },
      modelName: props.modelName,
      vpcConfig: this.getVpcConfig(props),
      enableNetworkIsolation: props.enableNetworkIsolation ?? false,
    });
    
    this.models.push(model);
    
    // Create endpoint configuration
    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: [
        {
          initialVariantWeight: 1.0,
          modelName: model.attrModelName,
          variantName: 'DefaultVariant',
          initialInstanceCount: props.initialInstanceCount,
          instanceType: props.instanceType,
        },
      ],
    });
    
    // Create endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
      endpointName: `${props.modelName}-endpoint`,
    });
    
    // Set up auto-scaling if configured
    if (props.autoScaling) {
      this.setupAutoScaling(props, this.endpoint, 'DefaultVariant');
    }
  }
  
  /**
   * Deploys multiple model variants under a single endpoint
   */
  private deployMultiVariant(props: SageMakerModelServingProps): void {
    if (!props.modelVariants || props.modelVariants.length === 0) {
      throw new Error('modelVariants is required for multi-variant deployment');
    }
    
    // Create models for each variant
    props.modelVariants.forEach((variant, index) => {
      const model = new sagemaker.CfnModel(this, `Model-${variant.variantName}`, {
        executionRoleArn: this.executionRole.roleArn,
        primaryContainer: {
          modelDataUrl: `s3://${variant.modelArtifacts.bucketName}/${variant.modelArtifacts.objectKey}`,
          image: this.getContainerImage(props, variant),
          environment: {
            // Environment variables for AppConfig integration
            APPCONFIG_APPLICATION: props.appConfig.applicationName,
            APPCONFIG_ENVIRONMENT: props.appConfig.environmentName,
            APPCONFIG_PROFILE: props.appConfig.configurationProfileName,
            VARIANT_NAME: variant.variantName,
          },
        },
        modelName: `${props.modelName}-${variant.variantName}`,
        vpcConfig: this.getVpcConfig(props),
        enableNetworkIsolation: props.enableNetworkIsolation ?? false,
      });
      
      this.models.push(model);
    });
    
    // Create endpoint configuration with all variants
    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: props.modelVariants.map((variant, index) => ({
        initialVariantWeight: variant.initialVariantWeight,
        modelName: this.models[index].attrModelName,
        variantName: variant.variantName,
        initialInstanceCount: variant.initialInstanceCount,
        instanceType: variant.instanceType,
      })),
    });
    
    // Create endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
      endpointName: `${props.modelName}-endpoint`,
    });
    
    // Set up auto-scaling for each variant if configured
    if (props.autoScaling) {
      props.modelVariants.forEach((variant) => {
        this.setupAutoScaling(props, this.endpoint, variant.variantName);
      });
    }
  }
  
  /**
   * Determines the appropriate container image based on model and region
   */
  private getContainerImage(props: SageMakerModelServingProps, variant?: ModelVariant): string {
    // This would be replaced with actual container image selection logic
    // based on framework, region, etc.
    // For example, retrieving the appropriate ECR image URI based on the
    // model framework and AWS region
    
    // Sample implementation - in a real implementation this would be more sophisticated
    const region = cdk.Stack.of(this).region;
    const accountId = cdk.Stack.of(this).account;
    
    // This is a placeholder - in a real implementation you would use the actual framework-specific images
    return `763104351884.dkr.ecr.${region}.amazonaws.com/pytorch-inference:2.5.1-cpu-py311-ubuntu22.04-sagemaker`;
  }
  
  /**
   * Configures VPC settings if provided
   */
  private getVpcConfig(props: SageMakerModelServingProps) {
    if (!props.vpc || !props.securityGroups || props.securityGroups.length === 0) {
      return undefined;
    }
    
    return {
      securityGroupIds: props.securityGroups.map(sg => sg.securityGroupId),
      subnets: props.vpc.privateSubnets.map(subnet => subnet.subnetId),
    };
  }
  
  /**
   * Sets up auto-scaling for the endpoint variants
   */
  private setupAutoScaling(
    props: SageMakerModelServingProps, 
    endpoint: sagemaker.CfnEndpoint, 
    variantName: string
  ): void {
    if (!props.autoScaling) {
      return;
    }
    
    // This would be implemented using the Application Auto Scaling service
    // to set up scaling policies for the SageMaker endpoint variant
    
    // In a complete implementation, you would:
    // 1. Register a scalable target
    // 2. Create scaling policies
    // 3. Set up CloudWatch alarms for scaling
    
    // This is left as a placeholder for customization
  }
  
  /**
   * Sets up monitoring for the SageMaker endpoint
   */
  private setupMonitoring(props: SageMakerModelServingProps): void {
    if (!props.monitoring) {
      return;
    }
    
    // Implement data quality monitoring if enabled
    if (props.monitoring.dataQualityEnabled) {
      const dataQualityMonitoring = new sagemaker.CfnMonitoringSchedule(this, 'DataQualityMonitoring', {
        monitoringScheduleName: `${props.modelName}-data-quality`,
        monitoringScheduleConfig: {
          scheduleConfig: {
            scheduleExpression: props.monitoring.scheduleExpression || 'cron(0 * ? * * *)', // Hourly by default
          },
          monitoringJobDefinition: {
            monitoringInputs: [{
              endpointInput: {
                endpointName: this.endpoint.endpointName as string,
                localPath: '/opt/ml/processing/input',
              }
            }],
            roleArn: this.executionRole.roleArn,
            baselineConfig: {
              // This would be configured with actual baseline constraints
              constraintsResource: {
                s3Uri: `s3://${props.appConfig.configBucket}/baselines/data-quality-constraints.json`,
              },
            },
            monitoringAppSpecification: {
              imageUri: this.getMonitoringImageUri('DataQuality'),
            },
            monitoringResources: {
              clusterConfig: {
                instanceCount: 1,
                instanceType: 'ml.m5.large',
                volumeSizeInGb: 20,
              },
            },
            monitoringOutputConfig: {
              monitoringOutputs: [
                {
                  s3Output: {
                    s3Uri: `s3://${props.appConfig.configBucket}/monitoring/data-quality`,
                    localPath: '/opt/ml/processing/output',
                  },
                },
              ],
            },
          },
        },
      });
      
      this.monitoringSchedules.push(dataQualityMonitoring);
    }
    
    // Similar implementations would be added for model quality, bias, and explainability
    // monitoring if they are enabled in the props
  }
  
  /**
   * Gets the appropriate monitoring image URI based on monitoring type
   */
  private getMonitoringImageUri(monitoringType: string): string {
    // This would be replaced with actual image URI selection logic
    // based on monitoring type and region
    const region = cdk.Stack.of(this).region;
    
    // Sample implementation - in a real implementation this would map to actual SageMaker monitoring images
    return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-model-monitor:latest`;
  }
  
  /**
   * Creates a CloudWatch dashboard for monitoring the endpoint
   */
  private createDashboard(props: SageMakerModelServingProps): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `SageMaker-${props.modelName}-Dashboard`,
    });
    
    // Add standard SageMaker metrics
    const invocationsMetric = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocations',
      dimensionsMap: {
        EndpointName: `${props.modelName}-endpoint`,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    
    const latencyMetric = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'OverheadLatency',
      dimensionsMap: {
        EndpointName: `${props.modelName}-endpoint`,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    
    const modelLatencyMetric = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'ModelLatency',
      dimensionsMap: {
        EndpointName: `${props.modelName}-endpoint`,
      },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    
    const invocationsWidget = new cloudwatch.GraphWidget({
      title: 'Invocations',
      left: [invocationsMetric],
    });
    
    const latencyWidget = new cloudwatch.GraphWidget({
      title: 'Latency',
      left: [latencyMetric, modelLatencyMetric],
    });
    
    dashboard.addWidgets(invocationsWidget, latencyWidget);
    
    // Add additional metrics based on deployment strategy
    if (props.deploymentStrategy === 'MULTI_VARIANT' && props.modelVariants) {
      // Add variant-specific metrics for multi-variant deployments
      const variantWidgets = props.modelVariants.map(variant => {
        const variantInvocationsMetric = new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'Invocations',
          dimensionsMap: {
            EndpointName: `${props.modelName}-endpoint`,
            VariantName: variant.variantName,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(1),
        });
        
        return new cloudwatch.GraphWidget({
          title: `${variant.variantName} Invocations`,
          left: [variantInvocationsMetric],
        });
      });
      
      dashboard.addWidgets(...variantWidgets);
    }
    
    return dashboard;
  }
  
  /**
   * Applies tags to all resources
   */
  private applyTags(props: SageMakerModelServingProps): void {
    if (!props.tags) {
      return;
    }
    
    const tags: cdk.CfnTag[] = Object.entries(props.tags).map(
      ([key, value]) => ({ key, value })
    );
    
    // Add default tags
    tags.push({ key: 'DeploymentStrategy', value: props.deploymentStrategy });
    tags.push({ key: 'ManagedBy', value: 'CDK-SageMaker-Construct' });
    
    // Apply tags to all resources
    this.models.forEach(model => {
      tags.forEach(tag => {
        cdk.Tags.of(model).add(tag.key, tag.value);
      });
    });
    
    tags.forEach(tag => {
      cdk.Tags.of(this.endpointConfig).add(tag.key, tag.value);
      cdk.Tags.of(this.endpoint).add(tag.key, tag.value);
      cdk.Tags.of(this.executionRole).add(tag.key, tag.value);
      cdk.Tags.of(this.dashboard).add(tag.key, tag.value);
    });
  }
}