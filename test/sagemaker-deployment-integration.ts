// test/integration/sagemaker-deployment.integration.test.ts
import * as cdk from 'aws-cdk-lib';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { SageMakerDeployment } from '../lib/sagemaker-deployment-construct-stack';
import { DeploymentType } from '../lib/model-serving/deployment-strategy-factory';
import { ScalingMetric } from '../lib/autoscaling/scaling-configration';
import { UpdateType } from '../lib/operations/update-strategies';

// Test stack for integration testing
class SageMakerIntegrationTestStack extends cdk.Stack {
  public readonly deployment: SageMakerDeployment;
  public readonly artifactBucket: s3.Bucket;
  public readonly configBucket: s3.Bucket;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create buckets for model artifacts and config
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.configBucket = new s3.Bucket(this, 'ConfigBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload test model artifact
    new s3deploy.BucketDeployment(this, 'DeployTestModel', {
      sources: [s3deploy.Source.asset('./test/integration/artifacts')],
      destinationBucket: this.artifactBucket,
      destinationKeyPrefix: 'models',
    });

    // Upload test configuration
    new s3deploy.BucketDeployment(this, 'DeployTestConfig', {
      sources: [s3deploy.Source.asset('./test/integration/config')],
      destinationBucket: this.configBucket,
      destinationKeyPrefix: 'config',
    });

    // Create a VPC for testing
    const vpc = new ec2.Vpc(this, 'TestVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Create a security group
    const securityGroup = new ec2.SecurityGroup(this, 'SageMakerSG', {
      vpc,
      description: 'Security group for SageMaker endpoints',
      allowAllOutbound: true,
    });

    // Deploy the SageMaker construct
    this.deployment = new SageMakerDeployment(this, 'TestDeployment', {
      namePrefix: 'integration-test',
      deploymentStrategy: DeploymentType.SINGLE_MODEL,
      models: [
        {
          name: 'test-model',
          artifacts: {
            bucketName: this.artifactBucket.bucketName,
            objectKey: 'models/model.tar.gz',
          },
          initialInstanceCount: 1,
          instanceType: 'ml.t2.medium',
        },
      ],
      appConfig: {
        applicationName: 'test-app',
        environmentName: 'test-env',
        configurationProfileName: 'test-profile',
        configBucket: this.configBucket.bucketName,
        configKey: 'config/model-config.json',
      },
      security: {
        encryptionEnabled: true,
        createKmsKey: true,
      },
      network: {
        vpc,
        existingSecurityGroups: [securityGroup],
        enableNetworkIsolation: false,
      },
      monitoring: {
        dataQualityEnabled: true,
        monitoringOutputBucket: this.artifactBucket.bucketName,
        monitoringOutputPrefix: 'monitoring',
        scheduleExpression: 'rate(1 day)',
      },
      autoscaling: {
        enabled: true,
        defaultMinInstanceCount: 1,
        defaultMaxInstanceCount: 3,
        defaultScalingMetric: ScalingMetric.CPU_UTILIZATION,
        defaultTargetValue: 70,
      },
        updateStrategy: UpdateType.BLUE_GREEN,
        updateStrategy: 'BLUE_GREEN',
        logging: {
          enableCloudWatchLogs: true,
          enableDataCaptureLogging: true,
          dataCapturePercentage: 10,
          dataCaptureS3Location: `s3://${this.artifactBucket.bucketName}/datacapture`,
        },
        deploymentHelpers: {
          enableInvocationTesting: true,
        },
        blueGreenConfig: {
          canarySize: 10,
          linearStepSize: 20,
          waitTimeInSeconds: 600,
        },
      },
    });

    // Add permissions for testing
    const testRole = new iam.Role(this, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    this.artifactBucket.grantReadWrite(testRole);
    this.configBucket.grantReadWrite(testRole);
    testRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'));

    // Output important values for testing
    new cdk.CfnOutput(this, 'EndpointName', {
      value: this.deployment.endpoint.endpointName || 'integration-test-endpoint',
      exportName: 'SageMakerEndpointName',
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      exportName: 'ModelArtifactBucketName',
    });

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: this.configBucket.bucketName,
      exportName: 'ModelConfigBucketName',
    });
  }
}

// Lambda function for testing endpoint
class EndpointTestStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, endpointName: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function to test the endpoint
    const testFunction = new cdk.aws_lambda.Function(this, 'TestFunction', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const sagemaker = new AWS.SageMaker();
        const sagemakerRuntime = new AWS.SageMakerRuntime();
        
        exports.handler = async (event) => {
          try {
            // Check if the endpoint exists and is in service
            const endpointStatus = await sagemaker.describeEndpoint({ EndpointName: '${endpointName}' }).promise();
            console.log('Endpoint status:', endpointStatus.EndpointStatus);
            
            if (endpointStatus.EndpointStatus !== 'InService') {
              return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Endpoint is not in service' }),
              };
            }
            
            // Invoke the endpoint with test data
            const testPayload = { instances: [[1, 2, 3, 4, 5]] };
            const response = await sagemakerRuntime.invokeEndpoint({
              EndpointName: '${endpointName}',
              ContentType: 'application/json',
              Body: JSON.stringify(testPayload),
            }).promise();
            
            return {
              statusCode: 200,
              body: response.Body.toString(),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({ message: error.message }),
            };
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
    });

    // Add necessary permissions
    testFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'sagemaker:DescribeEndpoint',
        'sagemaker:InvokeEndpoint',
      ],
      resources: ['*'],
    }));

    // Create a custom resource to run the test
    const provider = new cdk.custom_resources.Provider(this, 'Provider', {
      onEventHandler: testFunction,
    });

    // Run the test
    new cdk.CustomResource(this, 'EndpointTest', {
      serviceToken: provider.serviceToken,
      properties: {
        Timestamp: Date.now().toString(), // Force execution on updates
      },
    });
  }
}

// Lambda function for testing configuration updates
class ConfigUpdateTestStack extends cdk.Stack {
  constructor(
    scope: cdk.App, 
    id: string, 
    endpointName: string, 
    configBucketName: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Create Lambda function to test configuration updates
    const testFunction = new cdk.aws_lambda.Function(this, 'ConfigUpdateFunction', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        
        exports.handler = async (event) => {
          try {
            // Upload a new configuration file
            const configContent = JSON.stringify({
              threshold: 0.75,
              maxItems: 100,
              featureFlags: {
                enableNewFeature: true,
              },
              updatedAt: new Date().toISOString(),
            });
            
            await s3.putObject({
              Bucket: '${configBucketName}',
              Key: 'config/model-config.json',
              Body: configContent,
              ContentType: 'application/json',
            }).promise();
            
            console.log('Updated configuration file uploaded');
            
            // Wait for a few seconds to allow AppConfig to detect changes
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'Configuration updated successfully' }),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({ message: error.message }),
            };
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
    });

    // Add necessary permissions
    testFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:PutObject',
        's3:GetObject',
      ],
      resources: [`arn:aws:s3:::${configBucketName}/*`],
    }));

    // Create a custom resource to run the test
    const provider = new cdk.custom_resources.Provider(this, 'Provider', {
      onEventHandler: testFunction,
    });

    // Run the test
    new cdk.CustomResource(this, 'ConfigUpdateTest', {
      serviceToken: provider.serviceToken,
      properties: {
        Timestamp: Date.now().toString(), // Force execution on updates
      },
    });
  }
}

// Create test artifacts and configuration files
// Note: These would need to be created before running the tests
// test/integration/artifacts/model.tar.gz - A test model artifact
// test/integration/config/model-config.json - A test configuration file

describe('SageMakerDeployment Integration Tests', () => {
  // Template validation tests (can be run without actually deploying)
  test('Integration test stack synthesizes correctly', () => {
    // ARRANGE
    const app = new App();
    const stack = new SageMakerIntegrationTestStack(app, 'IntegrationTestStack');
    
    // ACT
    const template = Template.fromStack(stack);
    
    // ASSERT
    // Verify all the expected resources are created
    template.resourceCountIs('AWS::SageMaker::Model', 1);
    template.resourceCountIs('AWS::SageMaker::EndpointConfig', 1);
    template.resourceCountIs('AWS::SageMaker::Endpoint', 1);
    template.resourceCountIs('AWS::IAM::Role', Match.atLeast(2));
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 1);
    template.resourceCountIs('AWS::AppConfig::Application', 1);
    template.resourceCountIs('AWS::AppConfig::Environment', 1);
    template.resourceCountIs('AWS::AppConfig::ConfigurationProfile', 1);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });
  
  // End-to-end deployment tests (only run in CI/CD or controlled environment)
  // These tests are commented out since they would actually deploy resources to AWS
  /*
  test('Deploy and test the SageMaker endpoint', async () => {
    // This test would use the AWS CDK CLI programmatically or
    // AWS SDK to deploy the stack and test the endpoint
    
    // Steps:
    // 1. Create a test app and stack
    // 2. Deploy the stack to AWS
    // 3. Wait for deployment to complete
    // 4. Invoke the endpoint and verify response
    // 5. Clean up (destroy the stack)
  });
  
  test('Test configuration updates', async () => {
    // This test would update the configuration in S3 and validate
    // that the endpoint picks up the new configuration
    
    // Steps:
    // 1. Deploy the stack if not already deployed
    // 2. Upload a new configuration file to S3
    // 3. Wait for AppConfig to detect and deploy the changes
    // 4. Invoke the endpoint to verify it's using the new configuration
    // 5. Clean up
  });
  */
});

// Example of integration test runner script
// This would be run by a CI/CD pipeline or during development
// Note: You would have to implement the actual runner logic in a separate file
/*
// integration-test-runner.ts
async function runIntegrationTests() {
  try {
    // Create a new CDK app
    const app = new App();
    
    // Create our test stacks
    const testStack = new SageMakerIntegrationTestStack(app, 'IntegrationTestStack');
    
    // Synthesize the template
    const template = app.synth();
    
    // Deploy the stack
    console.log('Deploying test infrastructure...');
    // Use AWS CDK CLI or SDK to deploy
    
    // Wait for deployment to complete
    console.log('Waiting for deployment to complete...');
    // Implementation to wait for CloudFormation stack to complete
    
    // Get outputs
    const endpointName = 'integration-test-endpoint'; // Get from stack outputs
    const configBucketName = 'test-config-bucket'; // Get from stack outputs
    
    // Test the endpoint
    console.log('Testing endpoint functionality...');
    const endpointTestStack = new EndpointTestStack(app, 'EndpointTestStack', endpointName);
    // Deploy and run the endpoint test
    
    // Test configuration updates
    console.log('Testing configuration updates...');
    const configUpdateTestStack = new ConfigUpdateTestStack(app, 'ConfigUpdateTestStack', endpointName, configBucketName);
    // Deploy and run the configuration update test
    
    // Clean up
    console.log('Cleaning up resources...');
    // Destroy the stacks
    
    console.log('Integration tests completed successfully');
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exit(1);
  }
}

runIntegrationTests();
*/