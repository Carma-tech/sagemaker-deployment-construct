# Testing Guide for SageMaker Deployment Construct

This guide outlines the testing strategy for the SageMaker deployment construct, including unit tests, integration tests, and approaches for testing in a sandbox environment before production deployment.

## Table of Contents
- [Testing Philosophy](#testing-philosophy)
- [Test Directory Structure](#test-directory-structure)
- [Unit Testing](#unit-testing)
- [Integration Testing](#integration-testing)
- [Sandbox Environment Testing](#sandbox-environment-testing)
- [Test Automation](#test-automation)
- [Running the Tests](#running-the-tests)
- [Troubleshooting Tests](#troubleshooting-tests)

## Testing Philosophy

The testing strategy for this project follows these core principles:

1. **Test Each Level**: Every component is tested at multiple levels:
   - Unit tests for individual functions and classes
   - Integration tests for stacks and constructs working together
   - End-to-end tests for full deployments

2. **Test in Isolation**: Unit tests should run without AWS dependencies by using mocking techniques.

3. **Verify Infrastructure**: Tests should validate that the correct AWS resources are created with the expected properties.

4. **Test Before Production**: Full deployments should be tested in sandbox environments before moving to production.

## Test Directory Structure

```
test/
├── unit/                  # Unit tests for individual components
│   ├── stacks/            # Tests for CDK stacks
│   └── utils/             # Tests for utility modules
├── integration/           # Integration tests for combined components
└── e2e/                   # End-to-end tests for full deployments
```

## Unit Testing

Unit tests verify that individual components function correctly in isolation.

### Stack Unit Tests

For stack tests, we use the AWS CDK Assertions module to verify that the CloudFormation template contains the expected resources and properties.

Example:
```typescript
// Testing a stack creates the expected resources
test('creates a KMS key', () => {
  template.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
    Description: Match.stringLikeRegexp('KMS key for SageMaker resources encryption')
  });
});
```

### Utility Module Tests

For utility modules, we use standard Jest tests to verify the behavior of functions and classes.

Example:
```typescript
test('should return a valid JSON schema', () => {
  const schema = ConfigUtils.createSageMakerConfigSchema();
  // Assertions to validate the schema structure
  expect(parsedSchema.type).toBe('object');
  expect(parsedSchema.properties).toBeDefined();
});
```

## Integration Testing

Integration tests verify that multiple components work together correctly.

### Integration Test Strategy

1. **Stack Integration**: Tests how stacks interact with each other (e.g., how outputs from one stack are used as inputs to another)
2. **Environment Deployment**: Tests deploying multiple stacks together in a test environment
3. **Cross-Stack References**: Validates that cross-stack references work correctly

### Running Integration Tests

Integration tests can be run in two modes:

1. **Synthesis Only**: The default mode validates that stacks can be synthesized without errors but doesn't deploy them.
2. **Actual Deployment**: When `ENABLE_DEPLOYMENT` is set to `true`, stacks are actually deployed to AWS (use with caution).

## Sandbox Environment Testing

Before deploying to production, the construct should be tested in a sandbox environment. This allows verification of:

1. **Resource Creation**: Verify all AWS resources are created correctly
2. **Permissions and IAM**: Test that IAM roles and policies have the correct permissions
3. **Integration Points**: Test integration with other AWS services
4. **Performance and Scalability**: Test with realistic workloads
5. **Monitoring and Alerting**: Verify monitoring and alerting work as expected

### Sandbox Testing Process

1. **Create a Separate AWS Account**: Use a dedicated AWS account for sandbox testing
2. **Use Unique Prefixes**: Add unique prefixes to resource names to avoid conflicts
3. **Deploy Development Environment**: Use the development environment configuration
4. **Manual Verification**: Verify the deployment works as expected by:
   - Uploading test model artifacts
   - Invoking endpoints manually
   - Checking monitoring dashboards
5. **Load Testing**: Test the endpoint with realistic loads
6. **Clean Up**: Delete all resources after testing

### Cleanup Checklist

- [ ] SageMaker endpoints
- [ ] SageMaker models
- [ ] S3 buckets (delete objects first)
- [ ] IAM roles and policies
- [ ] CloudWatch dashboards and alarms
- [ ] AppConfig resources
- [ ] SNS topics
- [ ] CloudFormation stacks

## Test Automation

The project includes npm scripts to automate different types of tests:

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (useful during development)
npm run test:watch
```

## Running the Tests

### Prerequisites

- Node.js 18.x or later
- AWS CDK v2 installed
- AWS CLI configured with appropriate permissions
- TypeScript 5.x or later

### Running Unit Tests

```bash
npm run test:unit
```

Unit tests run locally and don't require AWS credentials. They validate:
- Stack structure and resource creation
- Utility function behavior
- Error handling and validation

### Running Integration Tests

```bash
npm run test:integration
```

By default, integration tests only validate that stacks can be synthesized. To deploy actual stacks:

1. Edit `test/integration/deploy-dev-environment.test.ts`
2. Set `ENABLE_DEPLOYMENT = true`
3. Run the integration tests

### Running Environment-Specific Deployments

```bash
# Deploy to development environment
npm run deploy:dev

# Deploy to test environment
npm run deploy:test

# Deploy to production environment
npm run deploy:prod
```

## Troubleshooting Tests

### Common Unit Test Issues

1. **Snapshot Mismatches**: If a template snapshot test fails, check if the changes are expected. If so, update the snapshot with `jest --updateSnapshot`.

2. **Resource Not Found**: If a test fails because a resource is not found in the template, check if the resource name or properties have changed.

3. **Mocked Service Issues**: If tests using mocked AWS services fail, check that the mock implementation matches the expected behavior.

### Common Integration Test Issues

1. **Deployment Failures**: If stack deployment fails:
   - Check CloudFormation events in the AWS Console
   - Verify AWS credentials have sufficient permissions
   - Check service limits for resources like SageMaker endpoints

2. **Cross-Stack Reference Errors**: If cross-stack references fail:
   - Verify stack dependencies are correctly defined
   - Check that imported resources are exported correctly from their source stacks

3. **Cleanup Issues**: If cleanup fails:
   - Resources might have dependencies that must be deleted first
   - Check CloudFormation stack deletion events for specific errors
   - Manually delete resources if necessary

---

## Best Practices for Adding New Tests

1. **Start with Unit Tests**: Always start by writing unit tests for new components.
2. **Test Edge Cases**: Include tests for edge cases and error conditions.
3. **Update Integration Tests**: Update integration tests when adding components that interact with existing ones.
4. **Keep Tests Independent**: Each test should be independent and not rely on the state from other tests.
5. **Use Descriptive Names**: Use descriptive test names that explain what's being tested and the expected outcome.
6. **Mock External Dependencies**: Use mocks for external services to avoid AWS costs and dependencies during testing.
