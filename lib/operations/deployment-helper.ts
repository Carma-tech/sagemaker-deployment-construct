// lib/operations/deployment-helper.ts
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DeploymentHelperProps {
  readonly endpointName: string;
  readonly modelName: string;
  readonly variantName?: string;
  readonly enableExplainability?: boolean;
  readonly enableModelQualityMonitoring?: boolean;
  readonly enableDataQualityMonitoring?: boolean;
}

export class DeploymentHelper extends Construct {
  constructor(scope: Construct, id: string, props: DeploymentHelperProps) {
    super(scope, id);
    
    // Create helper Lambda for operational tasks
    const helperFunction = this.createHelperFunction();
    
    // Deploy the function as a custom resource to perform operations
    const provider = new cr.Provider(this, 'HelperProvider', {
      onEventHandler: helperFunction,
    });
    
    // Create custom resource to execute operations
    new cr.AwsCustomResource(this, 'Operations', {
      onCreate: {
        service: 'SageMaker',
        action: 'describeEndpoint',
        parameters: {
          EndpointName: props.endpointName,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.endpointName}-helper`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      onUpdate: {
        service: 'SageMaker',
        action: 'describeEndpoint',
        parameters: {
          EndpointName: props.endpointName,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.endpointName}-helper`),
      },
    });
  }
  
  private createHelperFunction(): lambda.Function {
    // Create Lambda function with operational helpers
    const fn = new lambda.Function(this, 'HelperFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const sagemaker = new AWS.SageMaker();
        
        // Helper for getting model details
        async function getModelDetails(modelName) {
          const response = await sagemaker.describeModel({ ModelName: modelName }).promise();
          return response;
        }
        
        // Helper for getting endpoint details
        async function getEndpointDetails(endpointName) {
          const response = await sagemaker.describeEndpoint({ EndpointName: endpointName }).promise();
          return response;
        }
        
        // Helper for invoking endpoint with test data
        async function invokeEndpointTest(endpointName, payload) {
          const sagemakerRuntime = new AWS.SageMakerRuntime();
          try {
            const response = await sagemakerRuntime.invokeEndpoint({
              EndpointName: endpointName,
              ContentType: 'application/json',
              Body: JSON.stringify(payload),
            }).promise();
            
            return {
              statusCode: response.$response.httpResponse.statusCode,
              body: response.Body.toString(),
            };
          } catch (error) {
            console.error('Error invoking endpoint:', error);
            return {
              statusCode: error.$response?.httpResponse?.statusCode || 500,
              error: error.message,
            };
          }
        }
        
        // Main handler
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          const props = event.ResourceProperties;
          const {
            EndpointName,
            ModelName,
            VariantName,
            EnableExplainability,
            EnableModelQualityMonitoring,
            EnableDataQualityMonitoring,
          } = props;
          
          try {
            if (event.RequestType === 'Create' || event.RequestType === 'Update') {
              // Get model and endpoint details
              const modelDetails = await getModelDetails(ModelName);
              const endpointDetails = await getEndpointDetails(EndpointName);
              
              // Run a simple test invocation with dummy data
              const testPayload = { instances: [[1, 2, 3, 4, 5]] };
              const testInvocation = await invokeEndpointTest(EndpointName, testPayload);
              
              console.log('Operational check complete');
              
              return {
                PhysicalResourceId: \`\${EndpointName}-helper\`,
                Data: {
                  EndpointStatus: endpointDetails.EndpointStatus,
                  TestInvocationStatus: testInvocation.statusCode,
                  ModelArn: modelDetails.ModelArn,
                },
              };
            }
            
            if (event.RequestType === 'Delete') {
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
      description: 'Helper function for SageMaker operational tasks',
      memorySize: 256,
    });
    
    // Add necessary permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sagemaker:DescribeModel',
        'sagemaker:DescribeEndpoint',
        'sagemaker:InvokeEndpoint',
      ],
      resources: ['*'],
    }));
    
    return fn;
  }
}