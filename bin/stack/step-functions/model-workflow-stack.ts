/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

export class ModelWorkflowStack extends BaseStack {
  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);

    // Retrieve the S3 bucket name for configuration files from the stack configuration.
    const configBucketName = stackConfig.ConfigBucketName;
    if (!configBucketName) {
      throw new Error("ConfigBucketName must be provided in the stack configuration.");
    }
    // Import the existing bucket that holds your configuration JSON files.
    const configBucket = s3.Bucket.fromBucketName(this, 'ConfigBucket', configBucketName);

    // Create a Lambda function that simulates model retraining.
    const retrainLambda = new lambda.Function(this, 'RetrainModelLambda', {
      functionName: `${this.projectPrefix}-RetrainModelLambda`,
      code: lambda.Code.fromAsset('codes/lambda/model-workflow'),
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'retrain.lambda_handler',
      timeout: cdk.Duration.minutes(5),
      environment: {
        CONFIG_BUCKET: configBucket.bucketName,
        // Additional environment variables can be added as needed.
      },
    });

    // Grant the retraining Lambda read access to the configuration bucket.
    configBucket.grantRead(retrainLambda);

    // Create a Lambda function that simulates updating the SageMaker endpoint (i.e., model deployment).
    const deployLambda = new lambda.Function(this, 'DeployModelLambda', {
      functionName: `${this.projectPrefix}-DeployModelLambda`,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset('codes/lambda/model-workflow'),
      handler: 'deploy.lambda_handler',
      timeout: cdk.Duration.minutes(5),
      environment: {
        // For example, pass the SageMaker endpoint name from SSM.
        SAGEMAKER_ENDPOINT: this.getParameter('sageMakerEndpointName') || '',
      },
    });

    // Define Step Functions tasks that invoke the above Lambda functions.
    const retrainTask = new tasks.LambdaInvoke(this, 'RetrainModelTask', {
      lambdaFunction: retrainLambda,
      outputPath: '$.Payload',
    });

    const deployTask = new tasks.LambdaInvoke(this, 'DeployModelTask', {
      lambdaFunction: deployLambda,
      outputPath: '$.Payload',
    });

    // Define a Choice state to evaluate retraining success.
    const retrainSuccessChoice = new stepfunctions.Choice(this, 'Retrain Successful?')
      .when(
        stepfunctions.Condition.stringEquals('$.status', 'SUCCESS'),
        deployTask
      )
      .otherwise(new stepfunctions.Fail(this, 'Retrain Failed', {
        error: 'RetrainingError',
        cause: 'Model retraining failed',
      }));

    // Build the state machine definition.
    const definition = retrainTask.next(retrainSuccessChoice);

    // Create the state machine.
    const stateMachine = new stepfunctions.StateMachine(this, 'ModelWorkflowStateMachine', {
      stateMachineName: `${this.projectPrefix}-ModelWorkflowStateMachine`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(15),
    });

    // Output the state machine ARN for reference.
    new cdk.CfnOutput(this, 'StateMachineARN', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the Model Workflow State Machine',
    });
  }
}
