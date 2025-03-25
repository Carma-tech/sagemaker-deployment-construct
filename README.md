Below is an example README that documents the updated project requirements, architecture, and deployment steps. You can adjust sections as needed for your project.

---

# TextClassification ML Deployment Construct

This repository implements an AWS CDK v2-based infrastructure for deploying, serving, and monitoring machine learning models on AWS SageMaker. The project leverages dynamic configuration using AWS AppConfig to update model parameters at runtime without requiring redeployments. It includes multiple stacks for model training, archiving, serving, API hosting, testing, monitoring, and more.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Dynamic Configuration with AWS AppConfig](#dynamic-configuration-with-aws-appconfig)
- [Prerequisites](#prerequisites)
- [Setup and Installation](#setup-and-installation)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing](#testing)
- [Usage](#usage)
- [License](#license)

---

## Overview

This project provides a modular, reusable infrastructure for serving machine learning models using AWS SageMaker. It supports dynamic configuration using AWS AppConfig so that model parameters, endpoints, and operational settings can be updated on the fly. The project is built using the AWS Cloud Development Kit (CDK) in TypeScript and comprises several stacks, including:

- **ModelTrainingStack:** (Handles model training jobs.)
- **ModelArchivingStack:** (Archives trained models to an S3 bucket.)
- **ModelServingStack:** (Deploys models on SageMaker endpoints.)
- **APIHostingStack:** (Creates an API Gateway integrated with Lambda for model predictions.)
- **MonitorDashboardStack:** (Creates CloudWatch dashboards and alarms to monitor the endpoints.)
- **APITestingStack & TesterDashboardStack:** (Simulate client testing and provide testing dashboards.)
- **AppConfigOperationalStack:** (Provisions AWS AppConfig resources for dynamic configuration.)
- **SecurityOperationalEnhancementsStack:** (Implements security best practices and operational enhancements.)
- **ModelWorkflowStack:** (Orchestrates workflows such as model retraining and redeployment.)

---

## Architecture

The solution uses a multi-stack architecture where each stack is responsible for a specific part of the ML deployment lifecycle:

- **Dynamic Configuration:**  
  AWS AppConfig is used to host and manage configuration data (such as endpoint names, bucket names, and operational thresholds). A Lambda-backed custom resource queries AppConfig to fetch these parameters during deployment.

- **Inter-Stack Communication:**  
  Instead of relying on SSM Parameter Store, dynamic values are fetched directly from AppConfig, ensuring that updates can be applied without redeploying the entire infrastructure.

- **Monitoring & Testing:**  
  CloudWatch dashboards and alarms are set up for real-time monitoring. Separate stacks simulate API testing and aggregate metrics for further analysis.

- **CI/CD Pipeline:**  
  (Optional) A CI/CD stack integrates with CodePipeline/CodeBuild to automate deployments.

---

## Project Structure

```
amazon-sagemaker-model-serving-using-aws-cdk-v2/
├── bin/
│   ├── app-main.ts                   # Main CDK application entry point.
│   ├── stack/
│   │   ├── api-hosting/              # API hosting stack (API Gateway & Lambda integration).
│   │   ├── appconfig/                # AppConfigOperationalStack.
│   │   ├── cicd-pipeline/            # (Optional) CI/CD Pipeline stack.
│   │   ├── model-serving/            # ModelServingStack, ModelTrainingStack, etc.
│   │   ├── monitor-dashboard/        # MonitorDashboardStack, TesterDashboardStack.
│   │   └── security/                 # SecurityOperationalEnhancementsStack.
├── codes/
│   ├── lambda/
│   │   ├── api-hosting-predictor/     # Lambda code for API hosting predictor.
│   │   ├── api-testing-tester/        # Lambda code for API testing.
│   │   └── appconfig/
│   │       └── parameter-fetcher/     # Lambda code to fetch parameters from AWS AppConfig.
├── config/
│   └── app-config.json               # External configuration file.
├── lib/
│   ├── base/
│   │   └── base-stack.ts             # Base stack class with common methods.
│   └── utils/
│       └── config-loaders.ts         # Configuration loader (supports loading from S3).
├── package.json
├── README.md
└── tsconfig.json
```

---

## Dynamic Configuration with AWS AppConfig

Dynamic configuration allows you to update model parameters (such as SageMaker endpoint names, bucket names, thresholds, etc.) without redeploying your stacks. The key components include:

- **AppConfigOperationalStack:**  
  Provisions an AppConfig Application, Environment, Configuration Profile, and Deployment Strategy using parameters defined in your external configuration file.

- **Lambda Parameter Fetcher:**  
  A Lambda function (`codes/lambda/appconfig/parameter-fetcher/handler.py`) is used as a custom resource to retrieve dynamic configuration values from AppConfig. This function starts a configuration session to obtain a configuration token and then retrieves the latest configuration.

- **Custom Resource in Stacks:**  
  Stacks (such as ModelServingStack, APIHostingStack, MonitorDashboardStack, and APITestingStack) use a Lambda-backed custom resource to fetch dynamic parameters (like `sageMakerEndpointName`, `modelArtifactBucketName`, and `testTriggerSnsTopicName`) at deployment time.

---

## Prerequisites

- **AWS CDK v2** installed (recommended version 2.1005.0 or later).
- **Node.js** (v14 or later).
- **AWS CLI** configured with proper credentials.
- **jq** installed (for JSON processing in shell scripts, if needed).

---

## Setup and Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/your-repo/amazon-sagemaker-model-serving-using-aws-cdk-v2.git
   cd amazon-sagemaker-model-serving-using-aws-cdk-v2
   ```

2. **Install Dependencies:**

   ```bash
   npm install
   ```

3. **Bootstrap Your Environment:**

   ```bash
   cdk bootstrap aws://<ACCOUNT>/<REGION> --profile <PROFILE>
   ```

---

## Configuration

The project uses an external configuration file (`config/app-config.json`). Below is a sample configuration that includes dynamic configuration values:

```json
{
    "Project": {
        "Name": "TextClassificationv1",
        "Stage": "MLv1",
        "Account": "266735847556",
        "Region": "us-east-1",
        "Profile": "default"
    },
    "DynamicConfig": {
        "ApplicationId": "app-0a1b2c3d4e5f6g7h8",
        "EnvironmentId": "env-0a1b2c3d4e5f6g7h8",
        "ConfigurationProfileId": "cp-0a1b2c3d4e5f6g7h8",
        "DeploymentStrategyId": "ds-0a1b2c3d4e5f6g7h8"
    },
    "Stack": {
        "AppConfigOperational": {
            "Name": "AppConfigOperationalStackv1",
            "ApplicationName": "ModelConfigApp",
            "EnvironmentName": "ProdEnv",
            "ConfigurationProfileName": "ModelConfigProfile",
            "DeploymentStrategyName": "RollingStrategy",
            "DeploymentDurationInMinutes": 10,
            "GrowthFactor": 25
        },
        "ModelTraining": {
            "Name": "ModelTrainingStackv1",
            "ModelName": "text-classification-v1",
            "Version": "v1",
            "TrainingConfig": "config/model-training-config.yaml"
        },
        "ModelArchiving": {
            "Name": "ModelArchivingStackv1",
            "BucketBaseName": "model-archivingv1",
            "ModelList": [
                {
                    "ModelLocalPath": "models/model-a/model",
                    "ModelS3Key": "models/model-a/model"
                }
            ]
        },
        "ModelServing": {
            "Name": "ModelServingStack",
            "ModelList": [
                {
                    "ModelName": "Model-A-v1",
                    "ModelS3Key": "models/model-a/model",
                    "ModelDockerImage": "763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.5.1-cpu-py311-ubuntu22.04-sagemaker",
                    "VariantName": "Model-A-v1",
                    "VariantWeight": 1,
                    "InstanceCount": 1,
                    "InstanceType": "ml.m5.2xlarge",
                    "ServerlessConfig": {
                        "MaxConcurrency": 50,
                        "MemorySizeInMb": 2048
                    },
                    "ModelServerWorkers": "1",
                    "AutoScalingEnable": false,
                    "AutoScalingMinCapacity": 1,
                    "AutoScalingMaxCapacity": 2,
                    "AutoScalingTargetInvocation": 50
                }
            ],
            "EndpointConfigName": "TextClassification-Endpointv1",
            "BucketBaseName": "model-serving-v1",
            "DataLoggingEnable": true,
            "DataLoggingS3Key": "data-capture",
            "DataLoggingPercentage": 30,
            "EndpointName": "TextClassificationV1",
            "Deploy": true
        },
        "ModelTransformJob": {
            "Name": "ModelTransformJobStackv1",
            "BucketBaseName": "model-transform",
            "ModelList": [
                {
                    "ModelName": "Model-A-v1",
                    "InstanceType": "m4.xlarge",
                    "InputPath": "models/model-a/input",
                    "OutputPath": "models/model-a/output"
                }
            ]
        },
        "APIHosting": {
            "Name": "APIHostingStackv1",
            "APIGatewayName": "APIHosting",
            "ResourceName": "textv1",
            "ResourceMethod": "POST",
            "LambdaFunctionName": "TextClassificationPredictv1"
        },
        "MonitorDashboard": {
            "Name": "MonitorDashboardStackv1",
            "DashboardName": "MonitorDashboardv1",
            "SubscriptionEmails": ["abc@amazon.com"],
            "ApiGatewayOverallCallThreshold": 50,
            "ApiGatewayError4xxCallThreshold": 10,
            "ApiGatewayError5xxCallThreshold": 10
        },
        "CICDPipeline": {
            "Name": "CICDPipelineStackv1",
            "RepositoryName": "amazon-sagemaker-model-serving-using-aws-cdk-v2",
            "BranchName": "add-model-training-stack",
            "ConnectionArn": "arn:aws:codeconnections:us-east-1:717918134056:connection/7e4bcd1d-6aea-4dee-98e5-edf22f6cadb0"
        },
        "APITesting": {
            "Name": "APITestingStackv1",
            "SNSTopicName": "TestTriggerv1",
            "LambdaFunctionName": "TestTriggerv1",
            "TestClientCount": 10,
            "TestDurationInSec": 60,
            "TestIntervalInSec": 10
        },
        "TesterDashboard": {
            "Name": "TesterDashboardStackv1",
            "DashboardName": "TesterDashboardv1"
        },
        "SecurityOperationalEnhancements": {
            "Name": "SecurityOperationalStackv1",
            "BucketBaseName": "security-operational-bucket"
        },
        "ModelWorkflow": {
            "Name": "ModelWorkflowStackv1",
            "ConfigBucketName": "model-artifacts-bucket"
        }
    }
}
```

---

## Deployment

1. **Upload Configuration File:**  
   Upload your updated `app-config.json` to your S3 bucket (e.g., under the key `config/app-config.json`).

2. **Set Environment Variables:**  
   Export the following environment variables so that the configuration loader reads from S3:

   ```bash
   export CONFIG_BUCKET=your-config-bucket-name
   export CONFIG_KEY=config/app-config.json
   ```

3. **Bootstrap and Deploy:**  

   ```bash
   cdk bootstrap aws://<ACCOUNT>/<REGION> --profile <PROFILE>
   cdk deploy  --all
   ```

   Make sure to deploy the AppConfigOperationalStack first (if not already deployed) so that your AppConfig resources are provisioned, then deploy the other stacks.

---

## Testing

- **Unit Tests:**  
  Unit tests are available under the `test/` directory. Use Jest to run these tests:

  ```bash
  npm test
  ```

- **Integration Testing:**  
  Once deployed, you can verify:
  - The dynamic parameters are fetched via AppConfig.
  - The SageMaker endpoints, API Gateway, and other resources function as expected.
  - CloudWatch dashboards display the correct metrics.

---

## Usage

- **Updating Dynamic Configuration:**  
  To update dynamic model parameters (e.g., endpoint names, thresholds), update the hosted configuration in AWS AppConfig or update your configuration file in S3 and deploy via AppConfig’s deployment process. This update propagates to all stacks using the custom resource.
  
- **Monitoring and Logging:**  
  CloudWatch dashboards (MonitorDashboardStack and TesterDashboardStack) show key performance indicators, and alarms can be set for critical metrics.

---

## License

This project is licensed under the MIT License.
