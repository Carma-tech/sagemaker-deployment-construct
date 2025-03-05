// lib/monitoring/dashboard.ts
import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import { Construct } from 'constructs';

export interface SageMakerDashboardProps {
  readonly dashboardName: string;
  readonly endpoint: sagemaker.CfnEndpoint;
  readonly endpointName: string;
  readonly modelName: string;
  readonly variantNames: string[];
  readonly includeInvocations?: boolean;
  readonly includeLatency?: boolean;
  readonly includeErrors?: boolean;
  readonly includeCpuUtilization?: boolean;
  readonly includeMemoryUtilization?: boolean;
  readonly includeDiskUtilization?: boolean;
  readonly includeModelLatency?: boolean;
  readonly includeCustomMetrics?: boolean;
  readonly customMetrics?: string[];
}

export class SageMakerDashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: SageMakerDashboardProps) {
    super(scope, id);

    // Create CloudWatch dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.dashboardName,
    });

    // Add standard widget layout based on the included metrics
    const widgets: cloudwatch.IWidget[] = [];

    // Text widget for dashboard title and description
    widgets.push(
      new cloudwatch.TextWidget({
        markdown: `# SageMaker Endpoint: ${props.endpointName}\n` +
                 `Model: ${props.modelName}\n\n` +
                 `This dashboard shows metrics for the SageMaker endpoint.`,
        width: 24,
        height: 2,
      })
    );

    // Row 1: Invocations and Errors
    const row1Widgets: cloudwatch.IWidget[] = [];

    if (props.includeInvocations !== false) {
      row1Widgets.push(this.createInvocationsWidget(props));
    }

    if (props.includeErrors !== false) {
      row1Widgets.push(this.createErrorsWidget(props));
      row1Widgets.push(this.create5xxErrorsWidget(props));
    }

    if (row1Widgets.length > 0) {
      widgets.push(...row1Widgets);
    }

    // Row 2: Latency metrics
    const row2Widgets: cloudwatch.IWidget[] = [];

    if (props.includeLatency !== false) {
      row2Widgets.push(this.createOverallLatencyWidget(props));
    }

    if (props.includeModelLatency !== false) {
      row2Widgets.push(this.createModelLatencyWidget(props));
    }

    if (row2Widgets.length > 0) {
      widgets.push(...row2Widgets);
    }

    // Row 3: Resource utilization
    const row3Widgets: cloudwatch.IWidget[] = [];

    if (props.includeCpuUtilization !== false) {
      row3Widgets.push(this.createCpuUtilizationWidget(props));
    }

    if (props.includeMemoryUtilization !== false) {
      row3Widgets.push(this.createMemoryUtilizationWidget(props));
    }

    if (props.includeDiskUtilization !== false) {
      row3Widgets.push(this.createDiskUtilizationWidget(props));
    }

    if (row3Widgets.length > 0) {
      widgets.push(...row3Widgets);
    }

    // Row 4: Custom metrics (if provided)
    if (props.includeCustomMetrics !== false && props.customMetrics && props.customMetrics.length > 0) {
      widgets.push(this.createCustomMetricsWidget(props));
    }

    // Add all widgets to dashboard
    this.dashboard.addWidgets(...widgets);
  }

  // Create widget for invocation metrics
  private createInvocationsWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'Invocations',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Sum',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Invocations',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for error metrics
  private createErrorsWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'ModelErrors',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Sum',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Model Errors',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for 5xx error metrics
  private create5xxErrorsWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'Invocation5XXErrors',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Sum',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: '5XX Errors',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for overall latency metrics
  private createOverallLatencyWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'OverallLatency',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Average',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Overall Latency (ms)',
      left: metrics,
      width: 12,
      height: 6,
    });
  }

  // Create widget for model latency metrics
  private createModelLatencyWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'ModelLatency',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Average',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Model Latency (ms)',
      left: metrics,
      width: 12,
      height: 6,
    });
  }

  // Create widget for CPU utilization metrics
  private createCpuUtilizationWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'CPUUtilization',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Average',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'CPU Utilization (%)',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for memory utilization metrics
  private createMemoryUtilizationWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'MemoryUtilization',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Average',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Memory Utilization (%)',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for disk utilization metrics
  private createDiskUtilizationWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    for (const variant of props.variantNames) {
      metrics.push(
        new cloudwatch.Metric({
          namespace: 'AWS/SageMaker',
          metricName: 'DiskUtilization',
          dimensionsMap: {
            EndpointName: props.endpointName,
            VariantName: variant,
          },
          statistic: 'Average',
          period: Duration.minutes(1),
        })
      );
    }

    return new cloudwatch.GraphWidget({
      title: 'Disk Utilization (%)',
      left: metrics,
      width: 8,
      height: 6,
    });
  }

  // Create widget for custom metrics
  private createCustomMetricsWidget(props: SageMakerDashboardProps): cloudwatch.GraphWidget {
    const metrics: cloudwatch.IMetric[] = [];

    if (props.customMetrics) {
      for (const metricName of props.customMetrics) {
        for (const variant of props.variantNames) {
          metrics.push(
            new cloudwatch.Metric({
              namespace: 'SageMaker/CustomMetrics',
              metricName: metricName,
              dimensionsMap: {
                EndpointName: props.endpointName,
                VariantName: variant,
              },
              statistic: 'Average',
              period: Duration.minutes(1),
            })
          );
        }
      }
    }

    return new cloudwatch.GraphWidget({
      title: 'Custom Metrics',
      left: metrics,
      width: 24,
      height: 6,
    });
  }
}