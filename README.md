# SageMaker Deployment Construct

A comprehensive AWS CDK-based construct library for deploying machine learning models on Amazon SageMaker with support for real-time, asynchronous, and serverless inference types.


## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Deployment Configuration](#deployment-configuration)
  - [Model Configuration](#model-configuration)
  - [Inference Types](#inference-types)
- [Usage](#usage)
  - [Basic Deployment](#basic-deployment)
  - [Environment-Based Deployment](#environment-based-deployment)
  - [Asynchronous Inference](#asynchronous-inference)
  - [Serverless Inference](#serverless-inference)
  - [Multiple Model Variants](#multiple-model-variants)
- [Stack Descriptions](#stack-descriptions)
- [Utility Modules](#utility-modules)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

This project provides a modular AWS CDK construct library that makes it easy to deploy, configure, and monitor machine learning models on Amazon SageMaker. It supports multiple deployment options including real-time endpoints, asynchronous inference, and serverless inference, with dynamic configuration management via AWS AppConfig.

## Features

- **Multiple Inference Types**: Support for real-time, asynchronous, and serverless inference
- **Dynamic Configuration**: Use AWS AppConfig to manage model configurations without redeployment
- **Multi-Environment Support**: Easily deploy to development, testing, and production environments
- **Security Best Practices**: Built-in encryption, fine-grained permissions, and secure communication
- **Comprehensive Monitoring**: CloudWatch dashboards, alarms, and metrics for operational visibility
- **Workflow Automation**: Step Functions workflows for model retraining and deployment
- **Multiple Model Variants**: Support for deploying multiple model variants under a single endpoint

## Architecture

The solution uses a modular, multi-stack architecture where each stack is responsible for a specific part of the ML deployment lifecycle:

```
┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐
│                   │     │                   │     │                   │
│  Base Infra Stack │────▶│  AppConfig Stack  │────▶│  SageMaker Model  │
│                   │     │                   │     │      Stack        │
└───────────────────┘     └───────────────────┘     └──────────┬────────┘
                                                               │
                                                               ▼
┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐
│                   │     │                   │     │                   │
│   Workflow Stack  │◀────│ Monitoring Stack  │◀────│ SageMaker Endpoint│
│    (Optional)     │     │   (Optional)      │     │      Stack        │
└───────────────────┘     └───────────────────┘     └───────────────────┘
```

## Installation

### Prerequisites

- Node.js 18.x or later
- AWS CDK v2
- AWS CLI configured with appropriate permissions
- TypeScript 5.x or later

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/sagemaker-deployment-construct.git
   cd sagemaker-deployment-construct
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Initialize your AWS environment (if not already done):
   ```bash
   cdk bootstrap aws://YOUR_ACCOUNT_NUMBER/YOUR_REGION
   ```

## Configuration

The construct uses configuration files to manage deployment options and model configurations.

### Deployment Configuration

The `config/deployment-config.json` file defines environment-specific settings:

```json
{
  "environments": {
    "dev": {
      "account": "123456789012",
      "region": "us-east-1",
      "stage": "dev",
      "appConfigSuffix": "dev",
      "enableMonitoring": false,
      "enableWorkflow": false,
      "createNewAppConfig": true,
      "inferenceType": "async",
      "asyncConfig": {
        "maxConcurrentInvocationsPerInstance": 5,
        "expiresInSeconds": 3600
      },
      "serverlessConfig": {
        "memorySize": 2048,
        "maxConcurrency": 5
      }
    },
    "test": {
      "account": "123456789012",
      "region": "us-east-1",
      "stage": "test",
      "appConfigSuffix": "test",
      "enableMonitoring": true,
      "enableWorkflow": true,
      "createNewAppConfig": true
    },
    "prod": {
      "account": "123456789012",
      "region": "us-east-1",
      "stage": "prod",
      "appConfigSuffix": "prod",
      "enableMonitoring": true,
      "enableWorkflow": true,
      "createNewAppConfig": false,
      "existingAppConfigAppId": "",
      "existingAppConfigEnvId": "",
      "existingAppConfigProfileId": ""
    }
  },
  "project": {
    "name": "sagemaker-deployment",
    "description": "SageMaker model deployment construct"
  },
  "modelArtifacts": {
    "s3KeyPrefix": "models/",
    "enableVersioning": true
  }
}
```

Key configuration parameters:

| Parameter | Description |
|-----------|-------------|
| `account` | AWS account ID to deploy to |
| `region` | AWS region to deploy to |
| `stage` | Environment stage (dev, test, prod) |
| `enableMonitoring` | Whether to deploy monitoring stack |
| `enableWorkflow` | Whether to deploy workflow stack |
| `createNewAppConfig` | Whether to create new AppConfig resources or use existing ones |
| `inferenceType` | Type of inference endpoint to create (realtime, async, serverless) |
| `asyncConfig` | Configuration for async inference endpoints |
| `serverlessConfig` | Configuration for serverless inference endpoints |

### Model Configuration

The `config/model-config.json` file defines model-specific settings:

```json
{
  "modelParameters": {
    "preprocessing": {
      "normalization": true,
      "featureEngineering": {
        "textTokenization": true,
        "stopwordRemoval": true
      }
    },
    "inference": {
      "thresholds": {
        "classification": 0.5,
        "confidence": 0.7
      },
      "batchSize": 10
    }
  },
  "sageMakerEndpointName": "sagemaker-deployment-endpoint",
  "modelList": [
    {
      "ModelName": "text-classification-model",
      "ModelS3Key": "models/text-classification/v1/model.tar.gz",
      "ModelDockerImage": "763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:2.0.0-cpu-py310",
      "VariantName": "PrimaryVariant",
      "VariantWeight": 1,
      "InstanceCount": 1,
      "InstanceType": "ml.m5.large",
      "ModelServerWorkers": 2,
      "ServerlessConfig": {
        "memorySize": 2048,
        "maxConcurrency": 5
      }
    }
  ]
}
```

### Inference Types

The construct supports three types of inference endpoints:

1. **Real-time Inference**:
   - Default mode for synchronous, low-latency predictions
   - Requires always-on instances
   - Supports up to 10 model variants per endpoint

2. **Asynchronous Inference**:
   - For long-running inference requests (up to 15 minutes)
   - Results delivered to S3 with optional SNS notifications
   - Better for large inputs/outputs and batch processing
   - Supports up to 10 model variants per endpoint

3. **Serverless Inference**:
   - On-demand, auto-scaling compute with no minimum provisioning
   - Pay only for the duration of the inference request
   - Automatically scales to zero when not in use
   - Limited to 5 model variants per endpoint

## Usage

### Basic Deployment

1. Configure your deployment and model configurations in the respective JSON files.

2. Deploy the stacks:
   ```bash
   npm run cdk deploy
   ```

### Environment-Based Deployment

Deploy to a specific environment using the `DEPLOYMENT_ENV` environment variable:

```bash
# Deploy to development environment
export DEPLOYMENT_ENV=dev
npm run cdk deploy

# Deploy to test environment
export DEPLOYMENT_ENV=test
npm run cdk deploy

# Deploy to production environment
export DEPLOYMENT_ENV=prod
npm run cdk deploy
```

### Asynchronous Inference

To deploy an asynchronous inference endpoint:

1. Update `deployment-config.json` to set `inferenceType` to `"async"`:
   ```json
   {
     "environments": {
       "dev": {
         "inferenceType": "async",
         "asyncConfig": {
           "maxConcurrentInvocationsPerInstance": 5,
           "expiresInSeconds": 3600
         }
       }
     }
   }
   ```

2. Deploy the stack:
   ```bash
   export DEPLOYMENT_ENV=dev
   npm run cdk deploy
   ```

3. Invoke the async endpoint (Python example):
   ```python
   import boto3

   sm_client = boto3.client('sagemaker-runtime')
   response = sm_client.invoke_endpoint_async(
       EndpointName='sagemaker-deployment-dev-async-endpoint',
       ContentType='application/json',
       InputLocation='s3://bucket-name/input/data.json'
   )

   # Get output location
   output_location = response['OutputLocation']
   print(f"Results will be available at: {output_location}")
   ```

### Serverless Inference

To deploy a serverless inference endpoint:

1. Update `deployment-config.json` to set `inferenceType` to `"serverless"`:
   ```json
   {
     "environments": {
       "dev": {
         "inferenceType": "serverless",
         "serverlessConfig": {
           "memorySize": 2048,
           "maxConcurrency": 5
         }
       }
     }
   }
   ```

2. Deploy the stack:
   ```bash
   export DEPLOYMENT_ENV=dev
   npm run cdk deploy
   ```

3. Invoke the serverless endpoint (Python example):
   ```python
   import boto3
   import json

   sm_client = boto3.client('sagemaker-runtime')
   response = sm_client.invoke_endpoint(
       EndpointName='sagemaker-deployment-dev-serverless-endpoint',
       ContentType='application/json',
       Body=json.dumps({"inputs": "This is a sample text to classify"})
   )

   result = json.loads(response['Body'].read().decode())
   print(result)
   ```

### Multiple Model Variants

The construct supports deploying multiple model variants under a single endpoint:

1. Update `model-config.json` to include multiple models:
   ```json
   {
     "modelList": [
       {
         "ModelName": "text-classification-model-v1",
         "VariantName": "PrimaryVariant",
         "VariantWeight": 0.7,
         "InstanceCount": 1,
         "InstanceType": "ml.m5.large"
       },
       {
         "ModelName": "text-classification-model-v2",
         "VariantName": "ExperimentalVariant",
         "VariantWeight": 0.3,
         "InstanceCount": 1,
         "InstanceType": "ml.m5.large"
       }
     ]
   }
   ```

2. Deploy the stack to create an endpoint with the specified variants.

**Note**:
- Real-time and async endpoints support up to 10 variants.
- Serverless endpoints are limited to a maximum of 5 variants.

## Stack Descriptions

The construct provides the following stacks:

| Stack | Description |
|-------|-------------|
| **SageMakerBaseInfraStack** | Creates foundational resources (S3 buckets, IAM roles, KMS keys) |
| **AppConfigStack** | Sets up AWS AppConfig for dynamic configuration management |
| **SageMakerModelStack** | Creates SageMaker model resources from model artifacts |
| **SageMakerEndpointStack** | Deploys real-time SageMaker endpoints with auto-scaling |
| **SageMakerAsyncEndpointStack** | Deploys asynchronous inference SageMaker endpoints |
| **SageMakerServerlessEndpointStack** | Deploys serverless inference SageMaker endpoints |
| **MonitorDashboardStack** | Creates CloudWatch dashboards, metrics, and alarms |
| **WorkflowStack** | Implements Step Functions workflows for model operations |

## Utility Modules

The project includes several utility modules to facilitate common operations:

| Module | Description |
|--------|-------------|
| **SecurityUtils** | Security-related helpers for IAM, KMS, and encryption |
| **ConfigUtils** | AppConfig integration helpers and configuration management |
| **MonitoringUtils** | CloudWatch metrics, dashboards, and alarm helpers |
| **EndpointUtils** | Endpoint configuration generators and deployment helpers |

## Troubleshooting

### Common Issues

1. **Deployment Failures**
   
   If stack deployment fails, check CloudFormation console for error details.
   
   Common causes:
   - Insufficient IAM permissions
   - Exceeding service limits
   - Invalid configuration parameters

2. **AppConfig Issues**
   
   If you see errors related to AppConfig:
   - Verify AWS AppConfig service is available in your region
   - Check that configuration files are valid JSON
   - Ensure IAM roles have proper AppConfig permissions

3. **Endpoint Deployment Failures**
   
   If SageMaker endpoint deployment fails:
   - Validate model artifacts exist in the S3 location
   - Check that Docker image URIs are correct and accessible
   - Verify instance types are supported in your region
   - For serverless, check memory size is in valid range (1024-6144 in 1GB increments)
   - For async, verify output bucket has proper permissions

4. **"Too Many Variants" Error for Serverless Endpoints**
   
   If you receive an error about too many variants:
   - Serverless endpoints are limited to 5 variants maximum
   - Split models across multiple endpoints if needed

### Logs and Diagnostics

- Check CloudWatch Logs for Lambda function errors
- Check SageMaker endpoint logs for model-related errors
- Monitor CloudWatch dashboards for endpoint performance metrics

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
