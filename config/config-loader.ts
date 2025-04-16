// lib/config/config-loader.ts
import * as fs from 'fs';
import * as path from 'path';
import { UpdateType } from '../lib/operations/update-strategies';
import { DeploymentType } from '../lib/model-serving/deployment-strategy-factory';
import { ScalingMetric } from '../lib/autoscaling/scaling-configration';

export interface DeploymentConfig {
  namePrefix: string;
  deploymentStrategy: string; // DeploymentType as string
  models: {
    name: string;
    variantName?: string;
    artifacts: {
      bucketName: string;
      objectKey: string;
    };
    initialInstanceCount: number;
    instanceType: string;
    initialVariantWeight?: number;
  }[];
  appConfig: {
    applicationName: string;
    environmentName: string;
    configurationProfileName: string;
    configBucket: string;
    configKey: string;
    schema?: string;
  };
  security?: {
    encryptionEnabled?: boolean;
    createKmsKey?: boolean;
    existingKmsKeyId?: string;
    volumeEncryptionEnabled?: boolean;
  };
  network?: {
    vpcId?: string;
    securityGroupIds?: string[];
    enableNetworkIsolation?: boolean;
    subnetType?: string;
  };
  monitoring?: {
    dataQualityEnabled?: boolean;
    modelQualityEnabled?: boolean;
    monitoringOutputBucket?: string;
    monitoringOutputPrefix?: string;
    scheduleExpression?: string;
  };
  autoscaling?: {
    enabled?: boolean;
    defaultMinInstanceCount?: number;
    defaultMaxInstanceCount?: number;
    defaultScalingMetric?: string; // ScalingMetric as string
    defaultTargetValue?: number;
    variantConfigs?: {
      [variantName: string]: {
        minInstanceCount?: number;
        maxInstanceCount?: number;
        scalingMetric?: string;
        targetValue?: number;
      };
    };
  };
  operations?: {
    updateStrategy?: string; // UpdateType as string
    logging?: {
      enableCloudWatchLogs?: boolean;
      logRetentionDays?: number;
      enableDataCaptureLogging?: boolean;
      dataCapturePercentage?: number;
      dataCaptureS3Location?: string;
    };
  };
}

export class ConfigLoader {
  public static loadConfig(configPath: string): DeploymentConfig {
    try {
      const configFile = path.resolve(configPath);
      const configContent = fs.readFileSync(configFile, 'utf8');
      return JSON.parse(configContent) as DeploymentConfig;
    } catch (error) {
      throw new Error(`Failed to load configuration from ${configPath}: ${error}`);
    }
  }

  public static convertToConstructProps(config: DeploymentConfig) {
    // Convert string enum values to actual enum values
    return {
      ...config,
      deploymentStrategy: config.deploymentStrategy as DeploymentType,
      autoscaling: config.autoscaling ? {
        ...config.autoscaling,
        defaultScalingMetric: config.autoscaling.defaultScalingMetric as ScalingMetric,
        variantConfigs: config.autoscaling.variantConfigs ? 
          Object.entries(config.autoscaling.variantConfigs).reduce((acc, [key, value]) => {
            acc[key] = {
              ...value,
              scalingMetric: value.scalingMetric as ScalingMetric,
            };
            return acc;
          }, {} as any) : undefined,
      } : undefined,
      operations: config.operations ? {
        ...config.operations,
        updateStrategy: config.operations.updateStrategy as UpdateType,
      } : undefined,
    };
  }
}