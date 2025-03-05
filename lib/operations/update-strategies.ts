// lib/operations/update-strategies.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export enum UpdateType {
  ROLLOVER = 'ROLLOVER',
  BLUE_GREEN = 'BLUE_GREEN',
}

export interface EndpointUpdateProps {
  readonly endpointName: string;
  readonly endpointConfigName: string;
  readonly updateType?: UpdateType;
  readonly autoRollbackConfiguration?: {
    readonly alarms?: string[];
    readonly maximumExecutionTimeoutInSeconds?: number;
  };
  readonly durationInSeconds?: number;
  readonly canarySize?: number;
  readonly linearStepSize?: number;
}

export class EndpointUpdateStrategy extends Construct {
  constructor(scope: Construct, id: string, props: EndpointUpdateProps) {
    super(scope, id);

    // Create Lambda function for endpoint updates
    const updateFunction = this.createUpdateFunction();
    
    // Create custom resource provider
    const provider = new cr.Provider(this, 'UpdateProvider', {
      onEventHandler: updateFunction,
    });
    
    // Create custom resource for endpoint update
    new cr.AwsCustomResource(this, 'EndpointUpdate', {
      onCreate: {
        service: 'SageMaker',
        action: 'updateEndpoint',
        parameters: {
          EndpointName: props.endpointName,
          EndpointConfigName: props.endpointConfigName,
          UpdateType: props.updateType || UpdateType.ROLLOVER,
          AutoRollbackConfiguration: props.autoRollbackConfiguration ? {
            Alarms: props.autoRollbackConfiguration.alarms,
            MaximumExecutionTimeoutInSeconds: props.autoRollbackConfiguration.maximumExecutionTimeoutInSeconds,
          } : undefined,
          BlueGreenUpdatePolicy: props.updateType === UpdateType.BLUE_GREEN ? {
            TrafficRoutingConfiguration: {
              Type: 'LINEAR',
              LinearStepSize: props.linearStepSize || 10,
              CanarySize: props.canarySize || 5,
            },
            TerminationWaitInSeconds: props.durationInSeconds || 600,
          } : undefined,
        },
        physicalResourceId: cr.PhysicalResourceId.of(props.endpointName),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
  }
  
  private createUpdateFunction(): lambda.Function {
    // Create Lambda function for handling endpoint updates
    const fn = new lambda.Function(this, 'UpdateFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const sagemaker = new AWS.SageMaker();
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          // Extract properties
          const props = event.ResourceProperties;
          const {
            EndpointName,
            EndpointConfigName,
            UpdateType,
            AutoRollbackConfiguration,
            BlueGreenUpdatePolicy,
          } = props;
          
          try {
            if (event.RequestType === 'Create' || event.RequestType === 'Update') {
              const params = {
                EndpointName,
                EndpointConfigName,
              };
              
              // Add deployment config for blue/green updates
              if (UpdateType === 'BLUE_GREEN') {
                params.DeploymentConfig = {
                  BlueGreenUpdatePolicy,
                  AutoRollbackConfiguration,
                };
              }
              
              // Request the endpoint update
              const response = await sagemaker.updateEndpoint(params).promise();
              console.log('Endpoint update initiated:', response);
              
              return {
                PhysicalResourceId: EndpointName,
                Data: {
                  EndpointArn: response.EndpointArn,
                },
              };
            }
            
            if (event.RequestType === 'Delete') {
              // No need to do anything on delete
              return { PhysicalResourceId: event.PhysicalResourceId };
            }
            
            return { PhysicalResourceId: event.PhysicalResourceId || 'default' };
          } catch (error) {
            console.error('Error:', error);
            throw error;
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
      description: 'Custom resource to handle SageMaker endpoint updates',
    });
    
    // Add necessary permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sagemaker:UpdateEndpoint',
        'sagemaker:DescribeEndpoint',
      ],
      resources: ['*'],
    }));
    
    return fn;
  }
}