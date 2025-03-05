// lib/monitoring/model-monitoring.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface ModelConstraints {
    readonly s3Uri: string;
    readonly recordPreprocessorSourceUri?: string;
    readonly postAnalyticsProcessorSourceUri?: string;
}

export interface DataQualityMonitoringProps {
    readonly enabled: boolean;
    readonly constraints?: ModelConstraints;
    readonly statistics?: ModelConstraints;
}

export interface ModelQualityMonitoringProps {
    readonly enabled: boolean;
    readonly constraints?: ModelConstraints;
    readonly statistics?: ModelConstraints;
    readonly problemType?: 'Regression' | 'BinaryClassification' | 'MulticlassClassification';
    readonly groundTruthS3Uri?: string;
}

export interface BiasMonitoringProps {
    readonly enabled: boolean;
    readonly constraints?: ModelConstraints;
    readonly configBlob?: string;
}

export interface ExplainabilityMonitoringProps {
    readonly enabled: boolean;
    readonly constraints?: ModelConstraints;
    readonly configBlob?: string;
}

export interface SageMakerModelMonitoringProps {
    readonly endpointName: string;
    readonly monitoringOutputBucket: s3.IBucket;
    readonly monitoringOutputPrefix: string;
    readonly dataQuality: DataQualityMonitoringProps;
    readonly modelQuality?: ModelQualityMonitoringProps;
    readonly bias?: BiasMonitoringProps;
    readonly explainability?: ExplainabilityMonitoringProps;
    readonly scheduleExpression: string; // cron expression
    readonly instanceType: string;
    readonly instanceCount: number;
    readonly maxRuntimeInSeconds?: number;
    readonly kmsKey?: string;
    readonly networkConfig?: {
        readonly enableNetworkIsolation?: boolean;
        readonly vpcSecurityGroupIds?: string[];
        readonly vpcSubnets?: string[];
    };
}

export class SageMakerModelMonitoring extends Construct {
    public readonly monitoringSchedules: sagemaker.CfnMonitoringSchedule[] = [];
    public readonly monitoringRole: iam.Role;

    constructor(scope: Construct, id: string, props: SageMakerModelMonitoringProps) {
        super(scope, id);

        // Create IAM role for monitoring
        this.monitoringRole = this.createMonitoringRole(props);

        // Create data quality monitoring schedule if enabled
        if (props.dataQuality.enabled) {
            const dataQualitySchedule = this.createDataQualityMonitoringSchedule(props);
            this.monitoringSchedules.push(dataQualitySchedule);
        }

        // Create model quality monitoring schedule if enabled
        if (props.modelQuality?.enabled) {
            const modelQualitySchedule = this.createModelQualityMonitoringSchedule(props);
            this.monitoringSchedules.push(modelQualitySchedule);
        }

        // Create bias monitoring schedule if enabled
        if (props.bias?.enabled) {
            const biasSchedule = this.createBiasMonitoringSchedule(props);
            this.monitoringSchedules.push(biasSchedule);
        }

        // Create explainability monitoring schedule if enabled
        if (props.explainability?.enabled) {
            const explainabilitySchedule = this.createExplainabilityMonitoringSchedule(props);
            this.monitoringSchedules.push(explainabilitySchedule);
        }
    }

    private createMonitoringRole(props: SageMakerModelMonitoringProps): iam.Role {
        // Create IAM role for monitoring
        const role = new iam.Role(this, 'MonitoringRole', {
            assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
            description: 'Role for SageMaker Model Monitoring',
        });

        // Grant permissions to read from endpoint
        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                'sagemaker:DescribeEndpoint',
                'sagemaker:DescribeEndpointConfig',
                'sagemaker:ListEndpointConfigs',
                'sagemaker:ListEndpoints',
                'sagemaker:InvokeEndpoint',
            ],
            resources: ['*'],
        }));

        // Grant permissions to write to CloudWatch Logs
        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
            ],
            resources: [
                `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/sagemaker/Endpoints/*`,
            ],
        }));

        // Grant permissions to put metrics in CloudWatch
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
        }));

        // Grant permissions to read/write monitoring output
        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                's3:GetObject',
                's3:PutObject',
                's3:ListBucket',
            ],
            resources: [
                props.monitoringOutputBucket.arnForObjects(`${props.monitoringOutputPrefix}/*`),
                props.monitoringOutputBucket.bucketArn,
            ],
        }));

        // Add permissions for constraints and statistics
        const addS3Permissions = (s3Uri: string) => {
            if (s3Uri.startsWith('s3://')) {
                const parts = s3Uri.substring(5).split('/');
                const bucketName = parts[0];
                const keyPrefix = parts.slice(1).join('/');

                role.addToPolicy(new iam.PolicyStatement({
                    actions: ['s3:GetObject'],
                    resources: [`arn:aws:s3:::${bucketName}/${keyPrefix}`],
                }));
            }
        };

        // Add permissions for data quality constraints and statistics
        if (props.dataQuality.constraints?.s3Uri) {
            addS3Permissions(props.dataQuality.constraints.s3Uri);
        }
        if (props.dataQuality.statistics?.s3Uri) {
            addS3Permissions(props.dataQuality.statistics.s3Uri);
        }

        // Add permissions for model quality constraints and statistics
        if (props.modelQuality?.constraints?.s3Uri) {
            addS3Permissions(props.modelQuality.constraints.s3Uri);
        }
        if (props.modelQuality?.statistics?.s3Uri) {
            addS3Permissions(props.modelQuality.statistics.s3Uri);
        }
        if (props.modelQuality?.groundTruthS3Uri) {
            addS3Permissions(props.modelQuality.groundTruthS3Uri);
        }

        // Add permissions for bias constraints
        if (props.bias?.constraints?.s3Uri) {
            addS3Permissions(props.bias.constraints.s3Uri);
        }

        // Add permissions for explainability constraints
        if (props.explainability?.constraints?.s3Uri) {
            addS3Permissions(props.explainability.constraints.s3Uri);
        }

        // Add KMS permissions if specified
        if (props.kmsKey) {
            role.addToPolicy(new iam.PolicyStatement({
                actions: [
                    'kms:Decrypt',
                    'kms:GenerateDataKey',
                ],
                resources: [props.kmsKey],
            }));
        }

        return role;
    }

    private createDataQualityMonitoringSchedule(props: SageMakerModelMonitoringProps): sagemaker.CfnMonitoringSchedule {
        // Create data quality monitoring job definition
        const monitoringJobDefinition: sagemaker.CfnMonitoringSchedule.MonitoringJobDefinitionProperty = {
            monitoringAppSpecification: {
                imageUri: this.getDataQualityImage(),
            },
            monitoringInputs: [
                {
                    endpointInput: {
                        endpointName: props.endpointName,
                        localPath: '/opt/ml/processing/input/endpoint',
                    },
                },
            ],
            monitoringOutputConfig: {
                monitoringOutputs: [
                    {
                        s3Output: {
                            s3Uri: `s3://${props.monitoringOutputBucket.bucketName}/${props.monitoringOutputPrefix}/data-quality`,
                            localPath: '/opt/ml/processing/output',
                        },
                    },
                ],
            },
            monitoringResources: {
                clusterConfig: {
                    instanceCount: props.instanceCount,
                    instanceType: props.instanceType,
                    volumeSizeInGb: 30,
                },
            },
            roleArn: this.monitoringRole.roleArn,
            stoppingCondition: {
                maxRuntimeInSeconds: props.maxRuntimeInSeconds || 3600,
            },
            // Include networkConfig here directly in the initial object creation
            networkConfig: props.networkConfig ? {
                enableNetworkIsolation: props.networkConfig.enableNetworkIsolation,
                vpcConfig: props.networkConfig.vpcSecurityGroupIds && props.networkConfig.vpcSubnets ? {
                    securityGroupIds: props.networkConfig.vpcSecurityGroupIds,
                    subnets: props.networkConfig.vpcSubnets,
                } : undefined,
            } : undefined,
        };

        // Add data quality baseline config if constraints or statistics are provided
        if (props.dataQuality.constraints || props.dataQuality.statistics) {
            const baselineConfig: sagemaker.CfnMonitoringSchedule.BaselineConfigProperty = {
                constraintsResource: props.dataQuality.constraints ? {
                    s3Uri: props.dataQuality.constraints.s3Uri,
                } : undefined,
                statisticsResource: props.dataQuality.statistics ? {
                    s3Uri: props.dataQuality.statistics.s3Uri,
                } : undefined,
            };

            (monitoringJobDefinition as any).dataQualityBaselineConfig = baselineConfig;
        }

        // Create monitoring schedule
        return new sagemaker.CfnMonitoringSchedule(this, 'DataQualityMonitoringSchedule', {
            monitoringScheduleName: `${props.endpointName}-data-quality-monitoring`,
            monitoringScheduleConfig: {
                monitoringJobDefinition,
                scheduleConfig: {
                    scheduleExpression: props.scheduleExpression,
                },
            },
        });
    }

    private createModelQualityMonitoringSchedule(props: SageMakerModelMonitoringProps): sagemaker.CfnMonitoringSchedule {
        if (!props.modelQuality) {
            throw new Error('Model quality properties must be provided');
        }

        if (!props.modelQuality.problemType) {
            throw new Error('Problem type must be specified for model quality monitoring');
        }

        if (!props.modelQuality.groundTruthS3Uri) {
            throw new Error('Ground truth S3 URI must be specified for model quality monitoring');
        }


        // Create data quality monitoring job definition
        const monitoringJobDefinition: sagemaker.CfnMonitoringSchedule.MonitoringJobDefinitionProperty = {
            monitoringAppSpecification: {
                imageUri: this.getModelQualityImage(),
            },
            monitoringInputs: [
                {
                    endpointInput: {
                        endpointName: props.endpointName,
                        localPath: '/opt/ml/processing/input/endpoint',
                    },
                },
                {
                    batchTransformInput: {
                        datasetFormat: {
                            csv: {
                                header: true,
                            },
                        },
                        localPath: '/opt/ml/processing/input/groundtruth',
                        s3DataDistributionType: 'FullyReplicated',
                        s3InputMode: 'File',
                        dataCapturedDestinationS3Uri: props.modelQuality.groundTruthS3Uri,
                    },
                },
            ],
            monitoringOutputConfig: {
                monitoringOutputs: [
                    {
                        s3Output: {
                            s3Uri: `s3://${props.monitoringOutputBucket.bucketName}/${props.monitoringOutputPrefix}/model-quality`,
                            localPath: '/opt/ml/processing/output',
                        },
                    },
                ],
            },
            monitoringResources: {
                clusterConfig: {
                    instanceCount: props.instanceCount,
                    instanceType: props.instanceType,
                    volumeSizeInGb: 30,
                },
            },
            roleArn: this.monitoringRole.roleArn,
            stoppingCondition: {
                maxRuntimeInSeconds: props.maxRuntimeInSeconds || 3600,
            },
            environment: {
                'problem_type': props.modelQuality.problemType,
            },

            // Include networkConfig here directly in the initial object creation
            networkConfig: props.networkConfig ? {
                enableNetworkIsolation: props.networkConfig.enableNetworkIsolation,
                vpcConfig: props.networkConfig.vpcSecurityGroupIds && props.networkConfig.vpcSubnets ? {
                    securityGroupIds: props.networkConfig.vpcSecurityGroupIds,
                    subnets: props.networkConfig.vpcSubnets,
                } : undefined,
            } : undefined,
        };
        ////
        // Add model quality baseline config if constraints or statistics are provided
        if (props.modelQuality.constraints || props.modelQuality.statistics) {
            const baselineConfig: sagemaker.CfnMonitoringSchedule.BaselineConfigProperty = {
                constraintsResource: props.modelQuality.constraints ? {
                    s3Uri: props.modelQuality.constraints.s3Uri,
                } : undefined,
                statisticsResource: props.modelQuality.statistics ? {
                    s3Uri: props.modelQuality.statistics.s3Uri,
                } : undefined,
            };

            (monitoringJobDefinition as any).modelQualityBaselineConfig = baselineConfig;
        }

        // Create monitoring schedule
        return new sagemaker.CfnMonitoringSchedule(this, 'ModelQualityMonitoringSchedule', {
            monitoringScheduleName: `${props.endpointName}-model-quality-monitoring`,
            monitoringScheduleConfig: {
                monitoringJobDefinition,
                scheduleConfig: {
                    scheduleExpression: props.scheduleExpression,
                },
            },
        });
    }

    private createBiasMonitoringSchedule(props: SageMakerModelMonitoringProps): sagemaker.CfnMonitoringSchedule {
        if (!props.bias) {
            throw new Error('Bias monitoring properties must be provided');
        }

        // Create bias monitoring job definition
        const monitoringJobDefinition: sagemaker.CfnMonitoringSchedule.MonitoringJobDefinitionProperty = {
            monitoringAppSpecification: {
                imageUri: this.getBiasImage(),
            },
            monitoringInputs: [
                {
                    endpointInput: {
                        endpointName: props.endpointName,
                        localPath: '/opt/ml/processing/input/endpoint',
                    },
                },
            ],
            monitoringOutputConfig: {
                monitoringOutputs: [
                    {
                        s3Output: {
                            s3Uri: `s3://${props.monitoringOutputBucket.bucketName}/${props.monitoringOutputPrefix}/bias`,
                            localPath: '/opt/ml/processing/output',
                        },
                    },
                ],
            },
            monitoringResources: {
                clusterConfig: {
                    instanceCount: props.instanceCount,
                    instanceType: props.instanceType,
                    volumeSizeInGb: 30,
                },
            },
            roleArn: this.monitoringRole.roleArn,
            stoppingCondition: {
                maxRuntimeInSeconds: props.maxRuntimeInSeconds || 3600,
            },
            environment: props.bias.configBlob ? {
                'bias_config': props.bias.configBlob,
            } : undefined,

            // Include networkConfig here directly in the initial object creation
            networkConfig: props.networkConfig ? {
                enableNetworkIsolation: props.networkConfig.enableNetworkIsolation,
                vpcConfig: props.networkConfig.vpcSecurityGroupIds && props.networkConfig.vpcSubnets ? {
                    securityGroupIds: props.networkConfig.vpcSecurityGroupIds,
                    subnets: props.networkConfig.vpcSubnets,
                } : undefined,
            } : undefined,
        };

        // Add model bias baseline config if constraints are provided
        if (props.bias.constraints) {
            const baselineConfig: sagemaker.CfnMonitoringSchedule.BaselineConfigProperty = {
                constraintsResource: {
                    s3Uri: props.bias.constraints.s3Uri,
                },
            };

            (monitoringJobDefinition as any).modelBiasBaselineConfig = baselineConfig;
        }

        // Create monitoring schedule
        return new sagemaker.CfnMonitoringSchedule(this, 'BiasMonitoringSchedule', {
            monitoringScheduleName: `${props.endpointName}-bias-monitoring`,
            monitoringScheduleConfig: {
                monitoringJobDefinition,
                scheduleConfig: {
                    scheduleExpression: props.scheduleExpression,
                },
            },
        });
    }

    private createExplainabilityMonitoringSchedule(props: SageMakerModelMonitoringProps): sagemaker.CfnMonitoringSchedule {
        if (!props.explainability) {
            throw new Error('Explainability monitoring properties must be provided');
        }

        // Create explainability monitoring job definition
        const monitoringJobDefinition: sagemaker.CfnMonitoringSchedule.MonitoringJobDefinitionProperty = {
            monitoringAppSpecification: {
                imageUri: this.getExplainabilityImage(),
            },
            monitoringInputs: [
                {
                    endpointInput: {
                        endpointName: props.endpointName,
                        localPath: '/opt/ml/processing/input/endpoint',
                    },
                },
            ],
            monitoringOutputConfig: {
                monitoringOutputs: [
                    {
                        s3Output: {
                            s3Uri: `s3://${props.monitoringOutputBucket.bucketName}/${props.monitoringOutputPrefix}/explainability`,
                            localPath: '/opt/ml/processing/output',
                        },
                    },
                ],
            },
            monitoringResources: {
                clusterConfig: {
                    instanceCount: props.instanceCount,
                    instanceType: props.instanceType,
                    volumeSizeInGb: 30,
                },
            },
            roleArn: this.monitoringRole.roleArn,
            stoppingCondition: {
                maxRuntimeInSeconds: props.maxRuntimeInSeconds || 3600,
            },
            environment: props.explainability.configBlob ? {
                'explainability_config': props.explainability.configBlob,
            } : undefined,

            // Include networkConfig here directly in the initial object creation
            networkConfig: props.networkConfig ? {
                enableNetworkIsolation: props.networkConfig.enableNetworkIsolation,
                vpcConfig: props.networkConfig.vpcSecurityGroupIds && props.networkConfig.vpcSubnets ? {
                    securityGroupIds: props.networkConfig.vpcSecurityGroupIds,
                    subnets: props.networkConfig.vpcSubnets,
                } : undefined,
            } : undefined,
        };

        // Add model explainability baseline config if constraints are provided
        if (props.explainability.constraints) {
            const baselineConfig: sagemaker.CfnMonitoringSchedule.BaselineConfigProperty = {
                constraintsResource: {
                    s3Uri: props.explainability.constraints.s3Uri,
                },
            };

            (monitoringJobDefinition as any).modelExplainabilityBaselineConfig = baselineConfig;
        }

        // Create monitoring schedule
        return new sagemaker.CfnMonitoringSchedule(this, 'ExplainabilityMonitoringSchedule', {
            monitoringScheduleName: `${props.endpointName}-explainability-monitoring`,
            monitoringScheduleConfig: {
                monitoringJobDefinition,
                scheduleConfig: {
                    scheduleExpression: props.scheduleExpression,
                },
            },
        });
    }

    // Get container images for different types of monitoring
    private getDataQualityImage(): string {
        // This should be replaced with actual URIs for each region
        const region = cdk.Stack.of(this).region;
        return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-model-monitor-analyzer:latest`;
    }

    private getModelQualityImage(): string {
        const region = cdk.Stack.of(this).region;
        return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-model-monitor-analyzer:latest`;
    }

    private getBiasImage(): string {
        const region = cdk.Stack.of(this).region;
        return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-clarify-processing:latest`;
    }

    private getExplainabilityImage(): string {
        const region = cdk.Stack.of(this).region;
        return `123456789012.dkr.ecr.${region}.amazonaws.com/sagemaker-clarify-processing:latest`;
    }
}