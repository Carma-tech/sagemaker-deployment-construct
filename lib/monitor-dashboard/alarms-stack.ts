// lib/monitoring/alarms.ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';

export interface AlarmThresholds {
  readonly invocationErrorPercent?: number;
  readonly invocation5xxErrorPercent?: number;
  readonly modelErrorPercent?: number;
  readonly overallLatencyP90Ms?: number;
  readonly modelLatencyP90Ms?: number;
  readonly cpuUtilizationPercent?: number;
  readonly memoryUtilizationPercent?: number;
  readonly diskUtilizationPercent?: number;
}

export interface SageMakerAlarmsProps {
  readonly alarmNamePrefix: string;
  readonly endpoint: sagemaker.CfnEndpoint;
  readonly endpointName: string;
  readonly variantNames: string[];
  readonly thresholds: AlarmThresholds;
  readonly evaluationPeriods?: number;
  readonly datapointsToAlarm?: number;
  readonly actionsEnabled?: boolean;
  readonly snsTopicArn?: string;
  readonly emailSubscriptions?: string[];
  readonly enableAnomalyDetection?: boolean;
  readonly anomalyDetectionBandWidth?: number; // Standard deviations from normal (default: 2)
}

export class SageMakerAlarms extends Construct {
  public readonly alarms: cloudwatch.Alarm[] = [];
  public readonly snsTopic?: sns.Topic;

  constructor(scope: Construct, id: string, props: SageMakerAlarmsProps) {
    super(scope, id);

    // Create SNS topic if needed
    if (props.snsTopicArn || props.emailSubscriptions?.length) {
      this.snsTopic = this.createSnsTopic(props);
    }

    // Set default values
    const evaluationPeriods = props.evaluationPeriods || 3;
    const datapointsToAlarm = props.datapointsToAlarm || 3;
    const actionsEnabled = props.actionsEnabled !== false;

    // Create standard threshold alarms
    this.createStandardAlarms(props, evaluationPeriods, datapointsToAlarm, actionsEnabled);

    // Create anomaly detection alarms if enabled
    if (props.enableAnomalyDetection) {
      this.createAnomalyDetectionAlarms(props, evaluationPeriods, datapointsToAlarm, actionsEnabled);
    }
  }

  private createSnsTopic(props: SageMakerAlarmsProps): sns.Topic {
    // Create new SNS topic or import existing one
    const topic = props.snsTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlarmTopic', props.snsTopicArn)
      : new sns.Topic(this, 'AlarmTopic', {
          displayName: `${props.alarmNamePrefix}-Alarms`,
          topicName: `${props.alarmNamePrefix}-Alarms`,
        });

    // Add email subscriptions if provided
    if (props.emailSubscriptions && props.emailSubscriptions.length > 0 && topic instanceof sns.Topic) {
      for (const email of props.emailSubscriptions) {
        topic.addSubscription(new subs.EmailSubscription(email));
      }
    }

    return topic as sns.Topic;
  }

  private createStandardAlarms(
    props: SageMakerAlarmsProps,
    evaluationPeriods: number,
    datapointsToAlarm: number,
    actionsEnabled: boolean
  ): void {
    // For each variant, create appropriate alarms based on thresholds
    for (const variant of props.variantNames) {
      // Error rate alarms
      if (props.thresholds.invocationErrorPercent !== undefined) {
        this.createInvocationErrorAlarm(
          props,
          variant,
          props.thresholds.invocationErrorPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      if (props.thresholds.invocation5xxErrorPercent !== undefined) {
        this.create5xxErrorAlarm(
          props,
          variant,
          props.thresholds.invocation5xxErrorPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      if (props.thresholds.modelErrorPercent !== undefined) {
        this.createModelErrorAlarm(
          props,
          variant,
          props.thresholds.modelErrorPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      // Latency alarms
      if (props.thresholds.overallLatencyP90Ms !== undefined) {
        this.createOverallLatencyAlarm(
          props,
          variant,
          props.thresholds.overallLatencyP90Ms,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      if (props.thresholds.modelLatencyP90Ms !== undefined) {
        this.createModelLatencyAlarm(
          props,
          variant,
          props.thresholds.modelLatencyP90Ms,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      // Resource utilization alarms
      if (props.thresholds.cpuUtilizationPercent !== undefined) {
        this.createCpuUtilizationAlarm(
          props,
          variant,
          props.thresholds.cpuUtilizationPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      if (props.thresholds.memoryUtilizationPercent !== undefined) {
        this.createMemoryUtilizationAlarm(
          props,
          variant,
          props.thresholds.memoryUtilizationPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }

      if (props.thresholds.diskUtilizationPercent !== undefined) {
        this.createDiskUtilizationAlarm(
          props,
          variant,
          props.thresholds.diskUtilizationPercent,
          evaluationPeriods,
          datapointsToAlarm,
          actionsEnabled
        );
      }
    }
  }

  private createAnomalyDetectionAlarms(
    props: SageMakerAlarmsProps,
    evaluationPeriods: number,
    datapointsToAlarm: number,
    actionsEnabled: boolean
  ): void {
    // For each variant, create anomaly detection alarms
    for (const variant of props.variantNames) {
      // Invocations anomaly detection
      this.createInvocationsAnomalyAlarm(
        props,
        variant,
        props.anomalyDetectionBandWidth || 2,
        evaluationPeriods,
        datapointsToAlarm,
        actionsEnabled
      );

      // Latency anomaly detection
      this.createLatencyAnomalyAlarm(
        props,
        variant,
        props.anomalyDetectionBandWidth || 2,
        evaluationPeriods,
        datapointsToAlarm,
        actionsEnabled
      );

      // Error rate anomaly detection
      this.createErrorAnomalyAlarm(
        props,
        variant,
        props.anomalyDetectionBandWidth || 2,
        evaluationPeriods,
        datapointsToAlarm,
        actionsEnabled
      );
    }
  }

  // Implementation of specific alarms
  private createInvocationErrorAlarm(
    props: SageMakerAlarmsProps,
    variant: string,
    threshold: number,
    evaluationPeriods: number,
    datapointsToAlarm: number,
    actionsEnabled: boolean
  ): void {
    // Create metrics for invocations and errors
    const invocationsMetric = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocations',
      dimensionsMap: {
        EndpointName: props.endpointName,
        VariantName: variant,
      },
      statistic: 'Sum',
      period: Duration.minutes(1),
    });

    const errorsMetric = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocation4XXErrors',
      dimensionsMap: {
        EndpointName: props.endpointName,
        VariantName: variant,
      },
      statistic: 'Sum',
      period: Duration.minutes(1),
    });

    // Create math expression for error percentage
    const errorPercentMetric = new cloudwatch.MathExpression({
      expression: '(errors / invocations) * 100',
      usingMetrics: {
        errors: errorsMetric,
        invocations: invocationsMetric,
      },
      period: Duration.minutes(1),
    });

    // Create alarm
    const alarm = new cloudwatch.Alarm(this, `${variant}InvocationErrorAlarm`, {
      alarmName: `${props.alarmNamePrefix}-${variant}-InvocationErrorPercent`,
      metric: errorPercentMetric,
      threshold,
      evaluationPeriods,
      datapointsToAlarm,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled,
    });

    // Add alarm actions if SNS topic exists
    if (this.snsTopic) {
      alarm.addAlarmAction(new SnsAction(this.snsTopic));
      alarm.addOkAction(new SnsAction(this.snsTopic));
    }

    this.alarms.push(alarm);
  }

  // More alarm implementations for other metrics...
  // (I'm showing one as an example, but the full implementation would include all the methods below)

  private create5xxErrorAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Similar implementation to createInvocationErrorAlarm but for 5XX errors
  }

  private createModelErrorAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for model errors
  }

  private createOverallLatencyAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for overall latency
  }

  private createModelLatencyAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for model latency
  }

  private createCpuUtilizationAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for CPU utilization
  }

  private createMemoryUtilizationAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for memory utilization
  }

  private createDiskUtilizationAlarm(props: SageMakerAlarmsProps, variant: string, threshold: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for disk utilization
  }

  private createInvocationsAnomalyAlarm(props: SageMakerAlarmsProps, variant: string, bandWidth: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for invocations anomaly detection
  }

  private createLatencyAnomalyAlarm(props: SageMakerAlarmsProps, variant: string, bandWidth: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for latency anomaly detection
  }

  private createErrorAnomalyAlarm(props: SageMakerAlarmsProps, variant: string, bandWidth: number, evaluationPeriods: number, datapointsToAlarm: number, actionsEnabled: boolean): void {
    // Implementation for error rate anomaly detection
  }
}