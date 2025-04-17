import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import { ConfigUtils } from '../../../lib/utils/config-utils';

describe('ConfigUtils', () => {
  describe('createSageMakerConfigSchema', () => {
    test('should return a valid JSON schema', () => {
      const schema = ConfigUtils.createSageMakerConfigSchema();
      const parsedSchema = JSON.parse(schema);
      
      // Validate schema structure
      expect(parsedSchema.type).toBe('object');
      expect(parsedSchema.properties).toBeDefined();
      expect(parsedSchema.properties.modelParameters).toBeDefined();
      expect(parsedSchema.properties.sageMakerEndpointName).toBeDefined();
      expect(parsedSchema.properties.modelList).toBeDefined();
      
      // Validate required fields
      expect(parsedSchema.required).toContain('modelParameters');
      expect(parsedSchema.required).toContain('modelList');
      expect(parsedSchema.required).toContain('sageMakerEndpointName');
    });
  });
  
  describe('setupAppConfig', () => {
    test('should create AppConfig resources', () => {
      // Create a test stack
      const stack = new Stack();
      
      // Mock S3 bucket
      const mockBucket = {
        grantReadWrite: jest.fn(),
        bucketName: 'test-bucket',
        bucketArn: 'arn:aws:s3:::test-bucket'
      };
      
      // Call the utility function
      const resources = ConfigUtils.setupAppConfig(stack, 'test-prefix', {
        configBucket: mockBucket as any,
        applicationName: 'TestApp',
        environmentName: 'TestEnv',
        configProfileName: 'TestProfile',
        deploymentStrategyName: 'TestStrategy'
      });
      
      // Verify resources were created
      expect(resources.application).toBeDefined();
      expect(resources.environment).toBeDefined();
      expect(resources.configProfile).toBeDefined();
      expect(resources.deploymentStrategy).toBeDefined();
      
      // Verify CDK template contains the expected resources
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Name: 'test-prefix-TestApp'
      });
      template.hasResourceProperties('AWS::AppConfig::Environment', {
        Name: 'test-prefix-TestEnv'
      });
      template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
        Name: 'test-prefix-TestProfile'
      });
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        Name: 'test-prefix-TestStrategy'
      });
    });
  });
});
