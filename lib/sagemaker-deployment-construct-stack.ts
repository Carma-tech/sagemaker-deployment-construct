// lib/sagemaker-deployment.ts
import * as cdk from 'aws-cdk-lib';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DeploymentType, DeploymentStrategyFactory } from './model-serving/deployment-strategy-factory';
import { ModelConfig } from './model-serving/deployment-strategy';
import { AppConfigIntegration } from './app-config/app-config-integration';
import { AppConfigDeploymentManager } from './app-config/appconfig-deployment';
import { SageMakerDashboard } from './monitor-dashboard/dashboard-stack';
import { SageMakerAlarms } from './monitor-dashboard/alarms-stack';
import { SageMakerModelMonitoring } from './monitor-dashboard/model-monitor-stack';
import { AlarmThresholds } from './monitor-dashboard/alarms-stack';
import { SageMakerExecutionRole } from './security/iam-roles';
import { EncryptionConfig } from './security/encryption';
import { NetworkSecurity } from './security/network-security';
import { EndpointScaling, VariantScalingConfig } from './autoscaling/endpoint-scaling';
import { ScalingMetric, ScalingPolicy, InstanceLimits } from './autoscaling/scaling-configration';
import { EndpointUpdateStrategy, UpdateType } from './operations/update-strategies';
import { LoggingConfiguration } from './operations/logging-configuration';
import { DeploymentHelper } from './operations/deployment-helper';

export interface ModelDefinition {
  readonly name: string;
  readonly variantName?: string;
  readonly artifacts: {
    readonly bucketName: string;
    readonly objectKey: string;
  };
  readonly initialInstanceCount: number;
  readonly instanceType: string;
  readonly initialVariantWeight?: number;
  readonly containerImage?: string;
}

export interface SageMakerDeploymentProps {
  /**
   * Name prefix for the deployment resources
   */
  readonly namePrefix: string;

  /**
   * Optional description of the deployment
   */
  readonly description?: string;

  /**
   * Deployment strategy for the model(s)
   */
  readonly deploymentStrategy: DeploymentType;

  /**
   * Model definitions to deploy
   */
  readonly models: ModelDefinition[];

  /**
   * AppConfig configuration for dynamic model configuration
   */
  readonly appConfig: {
    readonly applicationName: string;
    readonly environmentName: string;
    readonly configurationProfileName: string;
    readonly configBucket: string;
    readonly configKey: string;
    readonly schema?: string;
    readonly deploymentStrategy?: 'Immediate' | 'Standard' | 'Custom';
    readonly customDeploymentDuration?: number;
    readonly customDeploymentBakeTime?: number;
    readonly customDeploymentGrowthFactor?: number;
  };

  /**
   * Optional monitoring configuration
   */
  readonly monitoring?: {
    readonly dataQualityEnabled?: boolean;
    readonly modelQualityEnabled?: boolean;
    readonly biasEnabled?: boolean;
    readonly explainabilityEnabled?: boolean;
    readonly scheduleExpression?: string;
    readonly monitoringOutputBucket?: string;
    readonly monitoringOutputPrefix?: string;
    readonly groundTruthS3Uri?: string;
    readonly problemType?: 'Regression' | 'BinaryClassification' | 'MulticlassClassification';
    readonly alarmThresholds?: AlarmThresholds;
    readonly alarmEmails?: string[];
  };

  /**
   * Optional security configuration
   */
  readonly security?: {
    readonly encryptionEnabled?: boolean;
    readonly createKmsKey?: boolean;
    readonly existingKmsKeyId?: string;
    readonly kmsKeyAlias?: string;
    readonly kmsKeyAdminRoleArns?: string[];
    readonly kmsKeyUserRoleArns?: string[];
    readonly volumeEncryptionEnabled?: boolean;
  };

  /**
   * Optional network configuration
   */
  readonly network?: {
    readonly vpc?: ec2.IVpc;
    readonly existingSecurityGroups?: ec2.ISecurityGroup[];
    readonly enableNetworkIsolation?: boolean;
    readonly allowedIngressCidrs?: string[];
    readonly allowedIngressSecurityGroups?: ec2.ISecurityGroup[];
    readonly subnetType?: ec2.SubnetType;
    readonly createSecurityGroup?: boolean;
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

  /**
   * Optional autoscaling configuration
   */
  readonly autoscaling?: {
    readonly enabled?: boolean;
    readonly defaultScalingMetric?: ScalingMetric;
    readonly defaultTargetValue?: number;
    readonly defaultMinInstanceCount?: number;
    readonly defaultMaxInstanceCount?: number;
    readonly defaultScaleInCooldown?: cdk.Duration;
    readonly defaultScaleOutCooldown?: cdk.Duration;
    readonly variantConfigs?: {
      [variantName: string]: {
        minInstanceCount?: number;
        maxInstanceCount?: number;
        scalingMetric?: ScalingMetric;
        targetValue?: number;
        scaleInCooldown?: cdk.Duration;
        scaleOutCooldown?: cdk.Duration;
      };
    };
  };
   /**
   * Optional operations configuration
   */
   readonly operations?: {
    readonly updateStrategy?: UpdateType;
    readonly logging?: {
      readonly enableCloudWatchLogs?: boolean;
      readonly logRetentionDays?: logs.RetentionDays;
      readonly enableDataCaptureLogging?: boolean;
      readonly dataCapturePercentage?: number;
      readonly dataCaptureS3Location?: string;
    };
    readonly deploymentHelpers?: {
      readonly enableInvocationTesting?: boolean;
      readonly enableExplainability?: boolean;
    };
    readonly blueGreenConfig?: {
      readonly canarySize?: number;
      readonly linearStepSize?: number;
      readonly waitTimeInSeconds?: number;
      readonly alarmNames?: string[];
    };
  };

}

/**
 * Construct for deploying SageMaker models with integrated configuration management and monitoring
 */
export class SageMakerDeployment extends Construct {
  // Public properties
  public readonly endpoint: sagemaker.CfnEndpoint;
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;
  public readonly models: sagemaker.CfnModel | sagemaker.CfnModel[];
  public appConfigIntegration: AppConfigIntegration;
  public appConfigDeploymentManager: AppConfigDeploymentManager;
  public readonly executionRole: iam.Role;
  public dashboard: cloudwatch.Dashboard;
  public alarms: cloudwatch.Alarm[] = [];
  public modelMonitoring?: SageMakerModelMonitoring;
  public readonly encryptionConfig?: EncryptionConfig;
  public readonly networkSecurity?: NetworkSecurity;

  // Private properties
  private readonly props: SageMakerDeploymentProps;

  constructor(scope: Construct, id: string, props: SageMakerDeploymentProps) {
    super(scope, id);

    // Validate and store props
    this.props = this.validateProps(props);

    // Create encryption configuration if enabled
    if (this.props.security?.encryptionEnabled) {
      this.encryptionConfig = this.setupEncryption();
    }

    // Configure network security if VPC is provided
    if (this.props.network?.vpc) {
      this.networkSecurity = this.setupNetworkSecurity();
    }

    // Create the execution role for SageMaker
    this.executionRole = this.createExecutionRole();

    // Create model resources using the deployment strategy
    const deploymentResult = this.deployModels();
    this.models = deploymentResult.model;
    this.endpointConfig = deploymentResult.endpointConfig;
    this.endpoint = deploymentResult.endpoint;

    // Set up AppConfig integration
    this.setupAppConfigIntegration();

    // Set up monitoring and dashboard
    this.setupMonitoring();
    this.dashboard = this.createDashboard();

    // Apply tags to all resources
    this.applyTags();
  }

  private validateProps(props: SageMakerDeploymentProps): SageMakerDeploymentProps {
    // Required properties validation
    if (!props.namePrefix) {
      throw new Error('namePrefix is required');
    }

    if (!props.models || props.models.length === 0) {
      throw new Error('At least one model definition is required');
    }

    // Validate each model definition
    props.models.forEach((model, index) => {
      if (!model.name) {
        throw new Error(`Model at index ${index} is missing a name`);
      }

      if (!model.artifacts || !model.artifacts.bucketName || !model.artifacts.objectKey) {
        throw new Error(`Model ${model.name} is missing required artifact information`);
      }

      if (!model.instanceType) {
        throw new Error(`Model ${model.name} is missing instanceType`);
      }

      if (model.initialInstanceCount === undefined || model.initialInstanceCount < 1) {
        throw new Error(`Model ${model.name} must have initialInstanceCount >= 1`);
      }
    });

    // Deployment strategy validation
    if (props.deploymentStrategy === DeploymentType.SINGLE_MODEL && props.models.length > 1) {
      throw new Error('Only one model can be provided with SINGLE_MODEL deployment strategy');
    }

    // AppConfig validation
    if (!props.appConfig) {
      throw new Error('appConfig is required for dynamic configuration');
    }

    // VPC validation
    if (props.vpc && (!props.securityGroups || props.securityGroups.length === 0)) {
      throw new Error('securityGroups must be provided when vpc is specified');
    }

    return props;
  }

  private createExecutionRole(): iam.Role {
    // Get model artifact details
    const modelArtifactBuckets = this.props.models.map(model => model.artifacts.bucketName);
    const modelArtifactKeys = this.props.models.map(model => model.artifacts.objectKey);

    // Create execution role with appropriate permissions
    const executionRoleConstruct = new SageMakerExecutionRole(this, 'ExecutionRole', {
      namePrefix: this.props.namePrefix,
      modelArtifactBuckets,
      modelArtifactKeys,
      configBucket: this.props.appConfig.configBucket,
      configKey: this.props.appConfig.configKey,
      kmsKey: this.encryptionConfig?.kmsKey,
      cloudwatchLogsEnabled: true,
      cloudwatchMetricsEnabled: true,
      appConfigEnabled: true,
      vpcAccess: !!!this.props.network?.vpc,
    });

    return executionRoleConstruct.role;
  }

  // Add method to set up network security
  private setupNetworkSecurity(): NetworkSecurity {
    return new NetworkSecurity(this, 'NetworkSecurity', {
      namePrefix: this.props.namePrefix,
      vpc: this.props.network?.vpc,
      existingSecurityGroups: this.props.network?.existingSecurityGroups,
      enableNetworkIsolation: this.props.network?.enableNetworkIsolation,
      allowedIngressCidrs: this.props.network?.allowedIngressCidrs,
      allowedIngressSecurityGroups: this.props.network?.allowedIngressSecurityGroups,
      subnetType: this.props.network?.subnetType,
      createSecurityGroup: this.props.network?.createSecurityGroup,
    });
  }
  // Add method to set up encryption
  private setupEncryption(): EncryptionConfig {
    return new EncryptionConfig(this, 'Encryption', {
      namePrefix: this.props.namePrefix,
      createKey: this.props.security?.createKmsKey,
      existingKeyId: this.props.security?.existingKmsKeyId,
      keyAlias: this.props.security?.kmsKeyAlias,
      keyDescription: `KMS key for SageMaker deployment ${this.props.namePrefix}`,
      keyAdminRoleArns: this.props.security?.kmsKeyAdminRoleArns,
      keyUserRoleArns: this.props.security?.kmsKeyUserRoleArns,
      endpointEncryptionEnabled: true,
      volumeEncryptionEnabled: this.props.security?.volumeEncryptionEnabled !== false,
    });
  }

  private getS3Prefix(objectKey: string): string {
    const parts = objectKey.split('/');
    if (parts.length <= 1) {
      return objectKey;
    }

    // Return everything except the last part (filename)
    return parts.slice(0, parts.length - 1).join('/') + '/*';
  }

  // Add these properties to the SageMakerDeployment class
  public endpointScaling?: EndpointScaling;

  private deployModels() {
    // Convert model definitions to model configs
    const modelConfigs: ModelConfig[] = this.props.models.map(model => ({
      modelName: model.name,
      variantName: model.variantName || 'AllTraffic',
      modelArtifacts: {
        bucketName: model.artifacts.bucketName,
        objectKey: model.artifacts.objectKey,
      },
      initialInstanceCount: model.initialInstanceCount,
      instanceType: model.instanceType,
      initialVariantWeight: model.initialVariantWeight || 1.0,
      containerImage: model.containerImage || this.getDefaultContainerImage(),
      environment: {
        // Environment variables for AppConfig integration
        APPCONFIG_APPLICATION: this.props.appConfig.applicationName,
        APPCONFIG_ENVIRONMENT: this.props.appConfig.environmentName,
        APPCONFIG_PROFILE: this.props.appConfig.configurationProfileName,
      },
    }));

    // Get VPC configuration if network security is configured
    const vpcConfig = this.networkSecurity?.getVpcConfig();

    // Create the deployment strategy
    const strategy = DeploymentStrategyFactory.createStrategy(
      this.props.deploymentStrategy,
      {
        scope: this,
        id: 'Deployment',
        executionRole: this.executionRole,
        modelConfigs,
        vpcConfig,
        enableNetworkIsolation: this.networkSecurity?.enableNetworkIsolation,
        tags: this.props.tags,
        endpointName: `${this.props.namePrefix}-endpoint`,
      }
    );

    // Deploy using the strategy
    const deploymentResult = strategy.deploy();


    // Apply encryption if enabled
    if (this.encryptionConfig) {
      this.encryptionConfig.applyEndpointEncryption(deploymentResult.endpointConfig);

      if (this.props.security?.volumeEncryptionEnabled !== false) {
        // Apply volume encryption to models
        if (Array.isArray(deploymentResult.model)) {
          deploymentResult.model.forEach(model => {
            this.encryptionConfig!.applyVolumeEncryption(model);
          });
        } else {
          this.encryptionConfig.applyVolumeEncryption(deploymentResult.model);
        }
      }
    }

    // Set up autoscaling if enabled
    if (this.props.autoscaling?.enabled) {
      this.setupAutoscaling(deploymentResult.endpoint);
    }

    return deploymentResult;

    // Deploy using the strategy
    // return strategy.deploy();
  }

  private getVpcConfig() {
    if (!this.props.vpc || !this.props.securityGroups || this.props.securityGroups.length === 0) {
      return undefined;
    }

    return {
      securityGroupIds: this.props.securityGroups.map(sg => sg.securityGroupId),
      subnets: this.props.vpc.privateSubnets.map(subnet => subnet.subnetId),
    };
  }

  private getDefaultContainerImage(): string {
    // This would be replaced with actual container image selection logic
    // based on framework, region, etc.
    const region = cdk.Stack.of(this).region;
    return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-container:latest`;
  }

  private setupAppConfigIntegration(): void {
    // Get or import S3 bucket for configuration
    const configBucket = s3.Bucket.fromBucketName(
      this,
      'ConfigBucket',
      this.props.appConfig.configBucket
    );

    // Create AppConfig resources
    this.appConfigIntegration = new AppConfigIntegration(this, 'AppConfig', {
      applicationName: this.props.appConfig.applicationName,
      environmentName: this.props.appConfig.environmentName,
      configurationProfileName: this.props.appConfig.configurationProfileName,
      configurationBucket: configBucket,
      configurationKey: this.props.appConfig.configKey,
      deploymentStrategy: 'Standard',
      configurationSchema: this.props.appConfig.schema,
    });

    // Create deployment manager
    this.appConfigDeploymentManager = new AppConfigDeploymentManager(this, 'DeploymentManager', {
      application: this.appConfigIntegration.application,
      environment: this.appConfigIntegration.environment,
      configurationProfile: this.appConfigIntegration.configurationProfile,
      deploymentStrategy: this.appConfigIntegration.deploymentStrategy,
      configurationBucket: configBucket,
      configurationKey: this.props.appConfig.configKey,
    });

    // Update SageMaker execution role permissions
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'appconfig:StartConfigurationSession',
        'appconfig:GetLatestConfiguration',
      ],
      resources: [
        `arn:aws:appconfig:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:application/${this.appConfigIntegration.application.ref}`,
        `arn:aws:appconfig:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:application/${this.appConfigIntegration.application.ref}/environment/${this.appConfigIntegration.environment.ref}`,
        `arn:aws:appconfig:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:application/${this.appConfigIntegration.application.ref}/configurationprofile/${this.appConfigIntegration.configurationProfile.ref}`,
      ],
    }));
  }

  private setupMonitoring(): void {
    if (!this.props.monitoring) {
      return;
    }

    // Get variant names
    const variantNames: string[] = [];
    if (this.props.deploymentStrategy === DeploymentType.SINGLE_MODEL) {
      variantNames.push('AllTraffic');
    } else {
      this.props.models.forEach(model => {
        variantNames.push(model.variantName || 'AllTraffic');
      });
    }

    // Create dashboard
    const dashboard = new SageMakerDashboard(this, 'Dashboard', {
      dashboardName: `SageMaker-${this.props.namePrefix}-Dashboard`,
      endpoint: this.endpoint,
      endpointName: this.endpoint.endpointName || `${this.props.namePrefix}-endpoint`,
      modelName: this.props.namePrefix,
      variantNames,
      includeInvocations: true,
      includeLatency: true,
      includeErrors: true,
      includeCpuUtilization: true,
      includeMemoryUtilization: true,
      includeDiskUtilization: true,
      includeModelLatency: true,
    });

    this.dashboard = dashboard.dashboard;

    // Setup alarms if thresholds are provided
    if (this.props.monitoring.alarmThresholds) {
      const alarms = new SageMakerAlarms(this, 'Alarms', {
        alarmNamePrefix: this.props.namePrefix,
        endpoint: this.endpoint,
        endpointName: this.endpoint.endpointName || `${this.props.namePrefix}-endpoint`,
        variantNames,
        thresholds: this.props.monitoring.alarmThresholds,
        emailSubscriptions: this.props.monitoring.alarmEmails,
        enableAnomalyDetection: true,
      });

      this.alarms.push(...alarms.alarms);
    }

    // Setup model monitoring if enabled
    if (this.props.monitoring.dataQualityEnabled ||
      this.props.monitoring.modelQualityEnabled ||
      this.props.monitoring.biasEnabled ||
      this.props.monitoring.explainabilityEnabled) {

      // Ensure output bucket is specified
      if (!this.props.monitoring.monitoringOutputBucket) {
        throw new Error('Monitoring output bucket must be specified for model monitoring');
      }

      // Get or create output bucket
      const monitoringOutputBucket = s3.Bucket.fromBucketName(
        this,
        'MonitoringOutputBucket',
        this.props.monitoring.monitoringOutputBucket
      );

      // Create model monitoring
      this.modelMonitoring = new SageMakerModelMonitoring(this, 'ModelMonitoring', {
        endpointName: this.endpoint.endpointName || `${this.props.namePrefix}-endpoint`,
        monitoringOutputBucket,
        monitoringOutputPrefix: this.props.monitoring.monitoringOutputPrefix || 'monitoring',
        dataQuality: {
          enabled: this.props.monitoring.dataQualityEnabled || false,
        },
        modelQuality: this.props.monitoring.modelQualityEnabled ? {
          enabled: true,
          problemType: this.props.monitoring.problemType,
          groundTruthS3Uri: this.props.monitoring.groundTruthS3Uri,
        } : undefined,
        bias: this.props.monitoring.biasEnabled ? {
          enabled: true,
        } : undefined,
        explainability: this.props.monitoring.explainabilityEnabled ? {
          enabled: true,
        } : undefined,
        scheduleExpression: this.props.monitoring.scheduleExpression || 'rate(1 day)',
        instanceType: 'ml.m5.xlarge',
        instanceCount: 1,
        networkConfig: this.props.vpc ? {
          enableNetworkIsolation: this.props.enableNetworkIsolation,
          vpcSecurityGroupIds: this.props.securityGroups?.map(sg => sg.securityGroupId),
          vpcSubnets: this.props.vpc.privateSubnets.map(subnet => subnet.subnetId),
        } : undefined,
        kmsKey: this.props.kmsKey?.keyArn,
      });
    }
  }

  private createDashboard(): cloudwatch.Dashboard {
    // This will be implemented in the monitoring step
    // Placeholder for now to maintain the structure
    return new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `SageMaker-${this.props.namePrefix}-Dashboard`,
    });
  }

  // Add method to set up autoscaling
private setupAutoscaling(endpoint: sagemaker.CfnEndpoint): void {
  // Extract endpoint name
  const endpointName = endpoint.endpointName || `${this.props.namePrefix}-endpoint`;
  
  // Determine variant names based on deployment strategy
  const variantNames: string[] = [];
  if (this.props.deploymentStrategy === DeploymentType.SINGLE_MODEL) {
    variantNames.push(this.props.models[0].variantName || 'AllTraffic');
  } else {
    this.props.models.forEach(model => {
      variantNames.push(model.variantName || model.name);
    });
  }
  
  // Create scaling configuration for each variant
  const variants: VariantScalingConfig[] = variantNames.map(variantName => {
    // Get variant-specific config if available, otherwise use defaults
    const variantConfig = this.props.autoscaling?.variantConfigs?.[variantName];
    
    // Determine instance limits
    const instanceLimits: InstanceLimits = {
      minInstanceCount: variantConfig?.minInstanceCount || 
                        this.props.autoscaling?.defaultMinInstanceCount || 1,
      maxInstanceCount: variantConfig?.maxInstanceCount || 
                        this.props.autoscaling?.defaultMaxInstanceCount || 5,
    };
    
    // Determine scaling policy
    const scalingPolicy: ScalingPolicy = {
      metric: variantConfig?.scalingMetric || 
              this.props.autoscaling?.defaultScalingMetric || 
              ScalingMetric.CPU_UTILIZATION,
      targetValue: variantConfig?.targetValue || 
                  this.props.autoscaling?.defaultTargetValue || 
                  70, // Default target value is 70%
      scaleInCooldown: variantConfig?.scaleInCooldown || 
                      this.props.autoscaling?.defaultScaleInCooldown || 
                      cdk.Duration.seconds(300),
      scaleOutCooldown: variantConfig?.scaleOutCooldown || 
                       this.props.autoscaling?.defaultScaleOutCooldown || 
                       cdk.Duration.seconds(60),
    };
    
    return {
      variantName,
      instanceLimits,
      scalingPolicy,
    };
  });
  
  // Create endpoint scaling configuration
  this.endpointScaling = new EndpointScaling(this, 'AutoScaling', {
    endpointName,
    variants,
  });
}

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
    tags.add('DeploymentName', this.props.namePrefix);
    tags.add('DeploymentStrategy', this.props.deploymentStrategy);
  }
}