/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Utility class for creating CloudWatch metrics, alarms, and dashboards for SageMaker
 */
export class MonitoringUtils {
  /**
   * Creates standard SageMaker endpoint metrics
   */
  public static createEndpointMetrics(
    endpointName: string,
    variantName: string,
    region?: string,
    options: {
      includeLatency?: boolean;
      includeInvocations?: boolean;
      includeErrors?: boolean;
      includeUtilization?: boolean;
      period?: cdk.Duration;
      statistic?: string;
    } = {}
  ): { [key: string]: cloudwatch.Metric } {
    const metrics: { [key: string]: cloudwatch.Metric } = {};
    const period = options.period || cdk.Duration.minutes(1);
    
    // Standard dimensions for SageMaker metrics
    const dimensions = {
      EndpointName: endpointName,
      VariantName: variantName
    };

    if (options.includeLatency !== false) {
      metrics.modelLatency = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'ModelLatency',
        dimensionsMap: dimensions,
        statistic: options.statistic || 'p90',
        unit: cloudwatch.Unit.MILLISECONDS,
        period: period,
        region: region,
      });

      metrics.overallLatency = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'OverallLatency',
        dimensionsMap: dimensions,
        statistic: options.statistic || 'p90',
        unit: cloudwatch.Unit.MILLISECONDS,
        period: period,
        region: region,
      });
    }

    if (options.includeInvocations !== false) {
      metrics.invocations = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'Invocations',
        dimensionsMap: dimensions,
        statistic: 'Sum',
        unit: cloudwatch.Unit.COUNT,
        period: period,
        region: region,
      });

      metrics.invocationsPerInstance = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'InvocationsPerInstance',
        dimensionsMap: dimensions,
        statistic: 'Sum',
        unit: cloudwatch.Unit.COUNT,
        period: period,
        region: region,
      });
    }

    if (options.includeErrors !== false) {
      metrics.errors4xx = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'Invocation4XXErrors',
        dimensionsMap: dimensions,
        statistic: 'Sum',
        unit: cloudwatch.Unit.COUNT,
        period: period,
        region: region,
      });

      metrics.errors5xx = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'Invocation5XXErrors',
        dimensionsMap: dimensions,
        statistic: 'Sum',
        unit: cloudwatch.Unit.COUNT,
        period: period,
        region: region,
      });
      
      metrics.modelErrors = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'ModelLatencyErrors',
        dimensionsMap: dimensions,
        statistic: 'Sum',
        unit: cloudwatch.Unit.COUNT,
        period: period,
        region: region,
      });
    }

    if (options.includeUtilization !== false) {
      metrics.cpuUtilization = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'CPUUtilization',
        dimensionsMap: dimensions,
        statistic: 'Average',
        unit: cloudwatch.Unit.PERCENT,
        period: period,
        region: region,
      });

      metrics.memoryUtilization = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'MemoryUtilization',
        dimensionsMap: dimensions,
        statistic: 'Average',
        unit: cloudwatch.Unit.PERCENT,
        period: period,
        region: region,
      });

      metrics.diskUtilization = new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'DiskUtilization',
        dimensionsMap: dimensions,
        statistic: 'Average', 
        unit: cloudwatch.Unit.PERCENT,
        period: period,
        region: region,
      });
    }

    return metrics;
  }

  /**
   * Creates standard dashboard widgets for SageMaker endpoint metrics
   */
  public static createEndpointDashboard(
    scope: Construct,
    id: string,
    options: {
      dashboardName: string;
      endpointName: string;
      variantName: string;
      region?: string;
      period?: cdk.Duration;
      includePerformance?: boolean;
      includeErrors?: boolean;
      includeUtilization?: boolean;
    }
  ): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(scope, id, {
      dashboardName: options.dashboardName,
    });

    const metrics = this.createEndpointMetrics(
      options.endpointName,
      options.variantName,
      options.region,
      {
        period: options.period,
        includeLatency: options.includePerformance !== false,
        includeInvocations: options.includePerformance !== false,
        includeErrors: options.includeErrors !== false,
        includeUtilization: options.includeUtilization !== false,
      }
    );

    // Add performance metrics
    if (options.includePerformance !== false) {
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Endpoint Latency',
          left: [metrics.modelLatency, metrics.overallLatency],
          width: 12,
          height: 6,
        }),
        
        new cloudwatch.GraphWidget({
          title: 'Invocations',
          left: [metrics.invocations],
          right: [metrics.invocationsPerInstance],
          width: 12,
          height: 6,
        })
      );
    }

    // Add error metrics
    if (options.includeErrors !== false) {
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Invocation Errors',
          left: [metrics.errors4xx, metrics.errors5xx, metrics.modelErrors],
          width: 24,
          height: 6,
        })
      );
    }

    // Add utilization metrics
    if (options.includeUtilization !== false) {
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Resource Utilization',
          left: [metrics.cpuUtilization, metrics.memoryUtilization, metrics.diskUtilization],
          width: 24,
          height: 6,
        })
      );
    }

    return dashboard;
  }

  /**
   * Creates standard alarms for SageMaker endpoints
   */
  public static createEndpointAlarms(
    scope: Construct,
    id: string,
    options: {
      projectPrefix: string;
      endpointName: string;
      variantName: string;
      region?: string;
      alarmTopic?: sns.ITopic;
      latencyThresholdMs?: number;
      errorCountThreshold?: number;
      invocationLowThreshold?: number;
      cpuUtilizationHighThreshold?: number;
      evaluationPeriods?: number;
      datapointsToAlarm?: number;
    }
  ): { [key: string]: cloudwatch.Alarm } {
    const alarms: { [key: string]: cloudwatch.Alarm } = {};
    const metrics = this.createEndpointMetrics(
      options.endpointName,
      options.variantName,
      options.region,
      {
        includeLatency: true,
        includeInvocations: true,
        includeErrors: true,
        includeUtilization: true,
      }
    );
    
    // Create high latency alarm
    if (options.latencyThresholdMs) {
      alarms.highLatency = metrics.modelLatency.createAlarm(scope, `${id}HighLatency`, {
        alarmName: `${options.projectPrefix}-HighLatencyAlarm`,
        threshold: options.latencyThresholdMs,
        evaluationPeriods: options.evaluationPeriods || 3,
        datapointsToAlarm: options.datapointsToAlarm || 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alert when model inference latency is too high',
      });
    }
    
    // Create high error rate alarm
    if (options.errorCountThreshold) {
      alarms.highErrorRate = metrics.errors5xx.createAlarm(scope, `${id}HighErrorRate`, {
        alarmName: `${options.projectPrefix}-HighErrorRateAlarm`,
        threshold: options.errorCountThreshold,
        evaluationPeriods: options.evaluationPeriods || 3,
        datapointsToAlarm: options.datapointsToAlarm || 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alert when endpoint error rate is too high',
      });
    }
    
    // Create low invocation alarm
    if (options.invocationLowThreshold) {
      alarms.lowInvocation = metrics.invocations.createAlarm(scope, `${id}LowInvocation`, {
        alarmName: `${options.projectPrefix}-LowInvocationAlarm`,
        threshold: options.invocationLowThreshold,
        evaluationPeriods: options.evaluationPeriods || 5,
        datapointsToAlarm: options.datapointsToAlarm || 4,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        alarmDescription: 'Alert when endpoint invocation rate is too low',
      });
    }
    
    // Create high CPU utilization alarm
    if (options.cpuUtilizationHighThreshold) {
      alarms.highCpuUtilization = metrics.cpuUtilization.createAlarm(scope, `${id}HighCpuUtilization`, {
        alarmName: `${options.projectPrefix}-HighCpuUtilizationAlarm`,
        threshold: options.cpuUtilizationHighThreshold,
        evaluationPeriods: options.evaluationPeriods || 3,
        datapointsToAlarm: options.datapointsToAlarm || 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alert when endpoint CPU utilization is too high',
      });
    }
    
    // Add alarm actions if topic is provided
    if (options.alarmTopic) {
      Object.values(alarms).forEach(alarm => {
        // Add non-null assertion to tell TypeScript this is definitely not undefined
        const alarmAction = new cw_actions.SnsAction(options.alarmTopic!);
        alarm.addAlarmAction(alarmAction);
        alarm.addOkAction(alarmAction);
      });
    }
    
    return alarms;
  }

  /**
   * Sets up SageMaker Model Monitoring
   */
  public static setupModelMonitoring(
    scope: Construct,
    id: string,
    options: {
      projectPrefix: string;
      endpointName: string;
      modelExecutionRole: string;
      monitoringOutputBucket: s3.IBucket;
      monitoringScheduleName?: string;
      scheduleExpression?: string;
      enableDataQuality?: boolean;
      enableModelQuality?: boolean;
      baselineConstraintsPath?: string;
      baselineStatisticsPath?: string;
    }
  ): sagemaker.CfnMonitoringSchedule {
    // Create monitoring schedule with required properties
    const monitoringSchedule = new sagemaker.CfnMonitoringSchedule(scope, id, {
      monitoringScheduleName: options.monitoringScheduleName || `${options.projectPrefix}-monitoring-schedule`,
      monitoringScheduleConfig: {
        scheduleConfig: {
          scheduleExpression: options.scheduleExpression || 'cron(0 * ? * * *)', // Default to hourly
        },
        monitoringJobDefinition: {
          monitoringAppSpecification: {
            imageUri: `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/sagemaker-model-monitor-analyzer:latest`,
          },
          monitoringInputs: [
            {
              endpointInput: {
                endpointName: options.endpointName,
                localPath: '/opt/ml/processing/input',
              },
            },
          ],
          monitoringOutputConfig: {
            monitoringOutputs: [
              {
                s3Output: {
                  s3Uri: `s3://${options.monitoringOutputBucket.bucketName}/monitoring-output/${options.endpointName}`,
                  localPath: '/opt/ml/processing/output',
                },
              },
            ],
          },
          monitoringResources: {
            clusterConfig: {
              instanceCount: 1,
              instanceType: 'ml.m5.large',
              volumeSizeInGb: 20,
            }
          },
          roleArn: options.modelExecutionRole,
          baselineConfig: options.baselineConstraintsPath && options.baselineStatisticsPath ? {
            constraintsResource: {
              s3Uri: options.baselineConstraintsPath,
            },
            statisticsResource: {
              s3Uri: options.baselineStatisticsPath,
            },
          } : undefined,
        },
      },
    });

    return monitoringSchedule;
  }
}
