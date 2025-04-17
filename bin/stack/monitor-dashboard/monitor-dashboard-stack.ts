/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { CloudWatchDashboard } from './cloudwatch-dashboard';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

export class MonitorDashboardStack extends BaseStack {
  private readonly dashboard: CloudWatchDashboard;
  private readonly appConfig: any;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);
    this.appConfig = stackConfig.AppConfig;

    // Create a CloudWatch dashboard with a 1-minute period for metrics
    const dashboardName = stackConfig.DashboardName || 'EnhancedDashboard';
    this.dashboard = new CloudWatchDashboard(this, dashboardName, {
      projectFullName: this.projectPrefix,
      dashboardName: dashboardName,
      period: cdk.Duration.minutes(1),
    });

    // Import required roles and functions
    const lambdaRoleArn = cdk.Fn.importValue('LambdaExecutionAppconfigRoleArn');
    const lambdaRole = iam.Role.fromRoleArn(this, 'ImportedLambdaRole', lambdaRoleArn);

    const appConfigParameterFetcher = lambda.Function.fromFunctionAttributes(this,
      'AppconfigParameterFetcherRole',
      {
        functionArn: cdk.Fn.importValue('AppconfigParameterFetcher'),
        sameEnvironment: true,
      }
    );

    const provider = new cr.Provider(this, 'AppConfigParameterProvider', {
      onEventHandler: appConfigParameterFetcher,
      role: lambdaRole
    });

    // Get endpoint name from dynamic configuration
    const dynamicConfig = this.commonProps.appConfig.DynamicConfig;
    const dynamicParameterResource = new cdk.CustomResource(this, 'SageMakerEndpointParameter', {
      serviceToken: provider.serviceToken,
      properties: {
        ApplicationId: dynamicConfig.ApplicationId,
        EnvironmentId: dynamicConfig.EnvironmentId,
        ConfigurationProfileId: dynamicConfig.ConfigurationProfileId,
        ParameterKey: 'sageMakerEndpointName',
        RequiredMinimumPollIntervalInSeconds: 30,
      },
    });

    const endpointName = dynamicParameterResource.getAttString('ParameterValue');

    // Create enhanced monitoring widgets
    
    // 1. Instance Metrics
    const instanceMetrics = this.dashboard.createEndpointInstanceMetrics(
      endpointName,
      'VariantA',
      ['CPUUtilization', 'MemoryUtilization', 'DiskUtilization', 'GPUUtilization', 'GPUMemoryUtilization'],
      { statistic: 'Average', unit: cloudwatch.Unit.PERCENT }
    );
    this.dashboard.addWidgets(
      this.dashboard.createWidget('Endpoint Instance Utilization', instanceMetrics, 12)
    );

    // 2. Performance Metrics
    const latencyMetric = new cloudwatch.Metric({
      metricName: 'ModelLatency',
      namespace: '/aws/sagemaker/Endpoints',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'p90',
      unit: cloudwatch.Unit.MILLISECONDS,
      period: cdk.Duration.minutes(1),
      label: 'Model Latency (p90)',
    });

    const invocationsMetric = new cloudwatch.Metric({
      metricName: 'Invocations',
      namespace: 'AWS/SageMaker',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Sum',
      unit: cloudwatch.Unit.COUNT,
      period: cdk.Duration.minutes(1),
      label: 'Total Invocations',
    });

    this.dashboard.addWidgets(
      this.dashboard.createLeftRightWidget('Performance Metrics', [latencyMetric], [invocationsMetric], 24)
    );

    // 3. Error Metrics
    const error4xxMetric = new cloudwatch.Metric({
      metricName: 'Invocation4XXErrors',
      namespace: 'AWS/SageMaker',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Sum',
      unit: cloudwatch.Unit.COUNT,
      period: cdk.Duration.minutes(1),
      label: '4XX Errors',
    });

    const error5xxMetric = new cloudwatch.Metric({
      metricName: 'Invocation5XXErrors',
      namespace: 'AWS/SageMaker',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Sum',
      unit: cloudwatch.Unit.COUNT,
      period: cdk.Duration.minutes(1),
      label: '5XX Errors',
    });

    this.dashboard.addWidgets(
      this.dashboard.createWidget('Error Rates', [error4xxMetric, error5xxMetric], 12)
    );

    // 4. Model Metrics (if available)
    const accuracyMetric = new cloudwatch.Metric({
      metricName: 'ModelAccuracy',
      namespace: 'Custom/MachineLearning',
      dimensionsMap: { EndpointName: endpointName },
      statistic: 'Average',
      unit: cloudwatch.Unit.PERCENT,
      period: cdk.Duration.minutes(5),
      label: 'Model Accuracy',
    });

    const predictionLatencyMetric = new cloudwatch.Metric({
      metricName: 'PredictionLatency',
      namespace: 'Custom/MachineLearning',
      dimensionsMap: { EndpointName: endpointName },
      statistic: 'Average',
      unit: cloudwatch.Unit.MILLISECONDS,
      period: cdk.Duration.minutes(1),
      label: 'Prediction Latency',
    });

    this.dashboard.addWidgets(
      this.dashboard.createWidget('Model Metrics', [accuracyMetric, predictionLatencyMetric], 12)
    );

    // Set up CloudWatch Alarms
    
    // 1. Latency Alarm
    const latencyAlarm = latencyMetric.createAlarm(this, 'HighLatencyAlarm', {
      alarmName: `${this.projectPrefix}-HighLatencyAlarm`,
      threshold: stackConfig.Alarms?.LatencyThresholdMs || 1000,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when model inference latency is too high',
    });

    // 2. Error Rate Alarm
    const errorRateAlarm = error5xxMetric.createAlarm(this, 'HighErrorRateAlarm', {
      alarmName: `${this.projectPrefix}-HighErrorRateAlarm`,
      threshold: stackConfig.Alarms?.ErrorRateThreshold || 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when endpoint error rate is too high',
    });

    // 3. Low Invocation Alarm
    const lowInvocationAlarm = invocationsMetric.createAlarm(this, 'LowInvocationAlarm', {
      alarmName: `${this.projectPrefix}-LowInvocationAlarm`,
      threshold: stackConfig.Alarms?.MinInvocationsPerMinute || 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 4,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: 'Alert when endpoint invocation rate is too low',
    });

    // Set up SNS Topic for alarms
    const alarmTopic = new sns.Topic(this, 'ModelMonitoringAlarmTopic', {
      displayName: `${this.projectPrefix}-ModelMonitoringAlarms`,
      topicName: `${this.projectPrefix}-model-monitoring-alarms`,
    });

    // Add email subscriptions if configured
    if (stackConfig.AlarmNotifications?.EmailAddresses) {
      stackConfig.AlarmNotifications.EmailAddresses.forEach((email: string) => {
        alarmTopic.addSubscription(new subscriptions.EmailSubscription(email));
      });
    }

    // Add alarm actions
    [latencyAlarm, errorRateAlarm, lowInvocationAlarm].forEach(alarm => {
      alarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));
      alarm.addOkAction(new cw_actions.SnsAction(alarmTopic));
    });

    // Add Alarm Status Widgets
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Model Performance Alarms',
        alarms: [latencyAlarm, errorRateAlarm, lowInvocationAlarm],
        width: 24,
      })
    );
  }
}
