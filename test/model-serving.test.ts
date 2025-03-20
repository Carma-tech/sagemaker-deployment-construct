import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ModelServingStack } from '../bin/stack/model-serving/model-serving-stack';
import { StackCommonProps } from '../lib/base/base-stack';

// Dummy configuration to test the stack. Adjust properties as needed.
const dummyConfig = {
    DeploymentMode: "singleEndpoint",
    EndpointConfigName: "TestEndpointConfig",
    EndpointName: "TestEndpoint",
    Deploy: true,
    ModelList: [
        {
            ModelName: "Model-A",
            ModelS3Key: "models/model-a/model",
            ModelDockerImage: "763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.5.1-cpu-py311-ubuntu22.04-sagemaker",
            ModelServerWorkers: "1",
            VariantName: "VariantA",
            VariantWeight: 1,
            InstanceCount: 1,
            InstanceType: "ml.m5.large"
        }
    ]
};

const stackCommonProps: StackCommonProps = {
    projectPrefix: "TestProjectMLDemo",
    appConfig: {
        Project: {
            Name: "TestProject",
            Stage: "MLTest",
            Account: process.env.CDK_DEFAULT_ACCOUNT,
            Region: process.env.CDK_DEFAULT_REGION
        }
    },
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
};

test('EnhancedModelServingStack creates a SageMaker Model resource', () => {
    const app = new cdk.App();
    const stack = new ModelServingStack(app, stackCommonProps, dummyConfig);
    const template = Template.fromStack(stack);

    // Check that at least one SageMaker Model is created.
    template.resourceCountIs("AWS::SageMaker::Model", 1);

    // Validate that the model has the expected container image.
    template.hasResourceProperties("AWS::SageMaker::Model", {
        Containers: [{
            Image: dummyConfig.ModelList[0].ModelDockerImage,
        }],
    });
});
