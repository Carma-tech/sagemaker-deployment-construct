// lib/operations/logging-configuration.ts
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface LoggingConfigProps {
  readonly endpointName: string;
  readonly logGroupName?: string;
  readonly retentionDays?: logs.RetentionDays;
  readonly enableCloudWatchLogs?: boolean;
  readonly enableDataCaptureLogging?: boolean;
  readonly dataCapturePercentage?: number;
  readonly dataCaptureS3Location?: string;
  readonly jsonPath?: string;
}

export class LoggingConfiguration extends Construct {
  public readonly logGroup: logs.LogGroup;
  
  constructor(scope: Construct, id: string, props: LoggingConfigProps) {
    super(scope, id);
    
    // Create CloudWatch Logs group
    if (props.enableCloudWatchLogs !== false) {
      this.logGroup = new logs.LogGroup(this, 'LogGroup', {
        logGroupName: props.logGroupName || `/aws/sagemaker/Endpoints/${props.endpointName}`,
        retention: props.retentionDays || logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
    
    // Set up data capture logging if enabled
    if (props.enableDataCaptureLogging && props.dataCaptureS3Location) {
      this.setupDataCaptureLogging(props);
    }
  }
  
  private setupDataCaptureLogging(props: LoggingConfigProps): void {
    // This would typically be done through the endpoint config
    // SageMaker CDK construct doesn't directly support data capture configuration
    // so we would use the L1 construct CfnEndpointConfig and apply the data capture config
    
    // This would be implemented inside the main construct when creating the endpoint config
    // Example implementation:
    // ```
    // const endpointConfig = new sagemaker.CfnEndpointConfig(...);
    // endpointConfig.dataCaptureConfig = {
    //   captureContentTypeHeader: {
    //     csvContentTypes: ['text/csv'],
    //     jsonContentTypes: ['application/json'],
    //   },
    //   captureOptions: [
    //     {
    //       captureMode: 'Input',
    //     },
    //     {
    //       captureMode: 'Output',
    //     },
    //   ],
    //   destinationS3Uri: props.dataCaptureS3Location,
    //   initialSamplingPercentage: props.dataCapturePercentage || 10,
    //   enableCapture: true,
    // };
    // ```
  }
}