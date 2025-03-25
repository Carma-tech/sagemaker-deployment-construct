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

    const lambdaRoleArn = cdk.Fn.importValue('LambdaExecutionAppconfigRoleArn');
    // Convert the role ARN string to an IRole
    const lambdaRole = iam.Role.fromRoleArn(this, 'ImportedLambdaRole', lambdaRoleArn);

    // Import appconfig fetcher lambda from appconfig stack
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

    // Retrieve the SageMaker endpoint name from SSM (set by the serving stack)
    // const endpointName = this.getParameter('sageMakerEndpointName');
    const endpointName = dynamicParameterResource.getAttString('ParameterValue');


    // Optionally, if your config contains model list details, you can iterate over them.
    // For now, we assume one endpoint with variants, and we add enhanced metrics.
    // -----------------------------------------------------------------------
    // Widget: SageMaker Endpoint Instance Metrics (CPU, Memory, Disk)
    const instanceMetrics = this.dashboard.createEndpointInstanceMetrics(
      endpointName,
      'VariantA', // Replace with dynamic variant if needed.
      ['CPUUtilization', 'MemoryUtilization', 'DiskUtilization'],
      { statistic: 'Average', unit: cloudwatch.Unit.PERCENT }
    );
    this.dashboard.addWidgets(
      this.dashboard.createWidget('Endpoint Instance Utilization', instanceMetrics, 12)
    );

    // Widget: Inference Latency & Throughput
    // In this example, we assume the endpoint publishes ModelLatency, OverheadLatency, and Invocations metrics.
    const latencyMetric = new cloudwatch.Metric({
      metricName: 'ModelLatency',
      namespace: '/aws/sagemaker/Endpoints',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Average',
      unit: cloudwatch.Unit.MILLISECONDS,
      period: cdk.Duration.minutes(1),
      label: 'Model Latency',
    });
    const overheadLatencyMetric = new cloudwatch.Metric({
      metricName: 'OverheadLatency',
      namespace: '/aws/sagemaker/Endpoints',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Average',
      unit: cloudwatch.Unit.MILLISECONDS,
      period: cdk.Duration.minutes(1),
      label: 'Overhead Latency',
    });
    const invocationsMetric = new cloudwatch.Metric({
      metricName: 'Invocations',
      namespace: 'AWS/SageMaker',
      dimensionsMap: { EndpointName: endpointName, VariantName: 'VariantA' },
      statistic: 'Sum',
      unit: cloudwatch.Unit.COUNT,
      period: cdk.Duration.minutes(1),
      label: 'Invocations',
    });

    this.dashboard.addWidgets(
      this.dashboard.createLeftRightWidget('Inference Latency', [latencyMetric], [overheadLatencyMetric], 12),
      this.dashboard.createWidget('Endpoint Throughput', [invocationsMetric], 12)
    );

    // Widget: Error Rates (Invocation 4XX and 5XX errors)
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
      this.dashboard.createWidget('Endpoint Error Rates', [error4xxMetric, error5xxMetric], 12)
    );

    // Optional: Widget for Custom Model Accuracy (if published as custom metric)
    const accuracyMetric = new cloudwatch.Metric({
      metricName: 'ModelAccuracy',
      namespace: 'Custom/MachineLearning',
      dimensionsMap: { EndpointName: endpointName },
      statistic: 'Average',
      unit: cloudwatch.Unit.PERCENT,
      period: cdk.Duration.minutes(1),
      label: 'Model Accuracy',
    });
    this.dashboard.addWidgets(
      this.dashboard.createWidget('Model Accuracy', [accuracyMetric], 12)
    );

    // Create CloudWatch Alarms for Critical Metrics

    // Alarm for High Latency
    const latencyAlarm = latencyMetric.createAlarm(this, 'HighLatencyAlarm', {
      alarmName: `${this.projectPrefix}-HighLatencyAlarm`,
      threshold: 1000, // Adjust threshold as needed (ms)
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Alarm when model latency exceeds threshold',
    });
    // Set up SNS Topic for alarms (using a topic from config or create one)
    const alarmTopic = new sns.Topic(this, 'EnhancedAlarmTopic', {
      displayName: `${this.projectPrefix}-EnhancedAlarmTopic`,
      topicName: `${this.projectPrefix}-EnhancedAlarmTopic`,
    });
    // Subscribe emails if provided in config
    (stackConfig.SubscriptionEmails || []).forEach((email: string) =>
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(email))
    );
    latencyAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Alarm for High Error Rates
    const errorAlarm = error5xxMetric.createAlarm(this, 'HighErrorAlarm', {
      alarmName: `${this.projectPrefix}-HighErrorAlarm`,
      threshold: 5, // Adjust threshold as needed
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Alarm when 5XX error count is high',
    });
    errorAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Add Alarm Widgets to Dashboard
    this.dashboard.addWidgets(
      new cloudwatch.AlarmWidget({
        title: 'Latency Alarm',
        alarm: latencyAlarm,
        width: 12,
      }),
      new cloudwatch.AlarmWidget({
        title: 'Error Alarm',
        alarm: errorAlarm,
        width: 12,
      })
    );
  }
}
