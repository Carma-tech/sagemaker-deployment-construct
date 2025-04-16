// lib/deployment-strategy.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DeploymentResult {
  model: sagemaker.CfnModel | sagemaker.CfnModel[];
  endpointConfig: sagemaker.CfnEndpointConfig;
  endpoint: sagemaker.CfnEndpoint;
}

export interface ModelConfig {
  readonly modelName: string;
  readonly variantName: string;
  readonly modelArtifacts: {
    readonly bucketName: string;
    readonly objectKey: string;
  };
  readonly initialInstanceCount: number;
  readonly instanceType: string;
  readonly initialVariantWeight: number;
  readonly containerImage?: string;
  readonly environment?: Record<string, string>;
}

export interface DeploymentStrategyProps {
  readonly scope: Construct;
  readonly id: string;
  readonly executionRole: iam.Role;
  readonly modelConfigs: ModelConfig[];
  readonly vpcConfig?: {
    readonly securityGroupIds: string[];
    readonly subnets: string[];
  };
  readonly enableNetworkIsolation?: boolean;
  readonly tags?: Record<string, string>;
  readonly endpointName?: string;
  kmsKeyId?: string;
  
}

export interface IDeploymentStrategy {
  deploy(): DeploymentResult;
}