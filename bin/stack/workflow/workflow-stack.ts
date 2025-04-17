/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */

import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface WorkflowStackProps {
  Name?: string;
  modelArtifactBucket: s3.IBucket;
  configBucket: s3.IBucket;
  appConfigApplicationId: string;
  appConfigEnvironmentId: string;
  appConfigProfileId: string;
  sagemakerExecutionRole: iam.IRole;
  endpointName: string;
  scheduleRetraining?: boolean;
  retrainingScheduleExpression?: string;
}

export class WorkflowStack extends BaseStack {
  public readonly modelDeploymentStateMachine: sfn.StateMachine;
  public readonly modelRetrainingStateMachine?: sfn.StateMachine;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: WorkflowStackProps) {
    super(scope, 'WorkflowStack', props, stackConfig);

    // Create IAM role for state machine
    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      roleName: `${this.projectPrefix}-workflow-role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
    });

    // Add permissions for S3 and AppConfig
    stackConfig.modelArtifactBucket.grantRead(stateMachineRole);
    stackConfig.configBucket.grantReadWrite(stateMachineRole);

    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appconfig:GetConfiguration',
        'appconfig:StartConfigurationSession',
        'appconfig:CreateHostedConfigurationVersion',
        'appconfig:StartDeployment',
      ],
      resources: ['*'],
    }));

    // Create Lambda functions for workflow steps
    const validateModelLambda = new lambda.Function(this, 'ValidateModelFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'model_validator.handler',
      code: lambda.Code.fromAsset('codes/lambda/workflow'),
      environment: {
        MODEL_ARTIFACT_BUCKET: stackConfig.modelArtifactBucket.bucketName,
        CONFIG_BUCKET: stackConfig.configBucket.bucketName,
      },
      timeout: cdk.Duration.minutes(5),
    });

    const updateConfigLambda = new lambda.Function(this, 'UpdateConfigFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'config_updater.handler',
      code: lambda.Code.fromAsset('codes/lambda/workflow'),
      environment: {
        APP_CONFIG_APPLICATION_ID: stackConfig.appConfigApplicationId,
        APP_CONFIG_ENVIRONMENT_ID: stackConfig.appConfigEnvironmentId,
        APP_CONFIG_PROFILE_ID: stackConfig.appConfigProfileId,
        CONFIG_BUCKET: stackConfig.configBucket.bucketName,
      },
      timeout: cdk.Duration.minutes(5),
    });

    const updateEndpointLambda = new lambda.Function(this, 'UpdateEndpointFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'endpoint_updater.handler',
      code: lambda.Code.fromAsset('codes/lambda/workflow'),
      environment: {
        ENDPOINT_NAME: stackConfig.endpointName,
        EXECUTION_ROLE_ARN: stackConfig.sagemakerExecutionRole.roleArn,
      },
      timeout: cdk.Duration.minutes(10),
    });

    // Grant permissions to Lambda functions
    validateModelLambda.grantInvoke(stateMachineRole);
    updateConfigLambda.grantInvoke(stateMachineRole);
    updateEndpointLambda.grantInvoke(stateMachineRole);

    // Create model deployment workflow
    this.modelDeploymentStateMachine = this.createModelDeploymentWorkflow(
      validateModelLambda,
      updateConfigLambda,
      updateEndpointLambda,
      stateMachineRole
    );

    // Create model retraining workflow if scheduled retraining is enabled
    if (stackConfig.scheduleRetraining) {
      this.modelRetrainingStateMachine = this.createModelRetrainingWorkflow(
        stateMachineRole,
        stackConfig.modelArtifactBucket,
        stackConfig.sagemakerExecutionRole
      );

      // Set up scheduled event for retraining
      if (stackConfig.retrainingScheduleExpression) {
        const retrainingRule = new events.Rule(this, 'ModelRetrainingSchedule', {
          schedule: events.Schedule.expression(stackConfig.retrainingScheduleExpression),
          description: `Scheduled retraining for ${this.projectPrefix}`,
        });

        retrainingRule.addTarget(new targets.SfnStateMachine(this.modelRetrainingStateMachine));
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'ModelDeploymentStateMachineArn', {
      value: this.modelDeploymentStateMachine.stateMachineArn,
      description: 'ARN of the model deployment state machine',
      exportName: `${this.projectPrefix}-model-deployment-state-machine-arn`,
    });

    if (this.modelRetrainingStateMachine) {
      new cdk.CfnOutput(this, 'ModelRetrainingStateMachineArn', {
        value: this.modelRetrainingStateMachine.stateMachineArn,
        description: 'ARN of the model retraining state machine',
        exportName: `${this.projectPrefix}-model-retraining-state-machine-arn`,
      });
    }
  }

  private createModelDeploymentWorkflow(
    validateModelLambda: lambda.Function,
    updateConfigLambda: lambda.Function,
    updateEndpointLambda: lambda.Function,
    role: iam.Role
  ): sfn.StateMachine {
    // Define state machine steps
    const validateModel = new tasks.LambdaInvoke(this, 'ValidateModel', {
      lambdaFunction: validateModelLambda,
      outputPath: '$.Payload',
    });

    const updateConfig = new tasks.LambdaInvoke(this, 'UpdateAppConfig', {
      lambdaFunction: updateConfigLambda,
      outputPath: '$.Payload',
    });

    const waitForConfigDeployment = new sfn.Wait(this, 'WaitForConfigDeployment', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(2)),
    });

    const updateEndpoint = new tasks.LambdaInvoke(this, 'UpdateEndpoint', {
      lambdaFunction: updateEndpointLambda,
      outputPath: '$.Payload',
    });

    const waitForEndpointUpdate = new sfn.Wait(this, 'WaitForEndpointUpdate', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(10)),
    });

    const success = new sfn.Succeed(this, 'DeploymentSucceeded');
    const fail = new sfn.Fail(this, 'DeploymentFailed', {
      cause: 'Deployment validation failed',
      error: 'Validation failure',
    });

    // Create workflow definition
    const definition = sfn.Chain
      .start(validateModel)
      .next(new sfn.Choice(this, 'IsModelValid')
        .when(sfn.Condition.booleanEquals('$.modelValid', true), updateConfig)
        .otherwise(fail)
      )
      .next(waitForConfigDeployment)
      .next(updateEndpoint)
      .next(waitForEndpointUpdate)
      .next(success);

    // Create state machine
    return new sfn.StateMachine(this, 'ModelDeploymentWorkflow', {
      definition,
      role,
      stateMachineName: `${this.projectPrefix}-model-deployment`,
      timeout: cdk.Duration.minutes(30),
    });
  }

  private createModelRetrainingWorkflow(
    role: iam.Role, 
    modelBucket: s3.IBucket,
    sagemakerRole: iam.IRole
  ): sfn.StateMachine {
    // Create Lambda for initiating SageMaker training job
    const startTrainingLambda = new lambda.Function(this, 'StartTrainingFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'training_job.handler',
      code: lambda.Code.fromAsset('codes/lambda/workflow'),
      environment: {
        MODEL_ARTIFACT_BUCKET: modelBucket.bucketName,
        EXECUTION_ROLE_ARN: sagemakerRole.roleArn,
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Create Lambda for checking training job status
    const checkTrainingStatusLambda = new lambda.Function(this, 'CheckTrainingStatusFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'training_status.handler',
      code: lambda.Code.fromAsset('codes/lambda/workflow'),
      timeout: cdk.Duration.minutes(5),
    });

    startTrainingLambda.grantInvoke(role);
    checkTrainingStatusLambda.grantInvoke(role);

    // Define workflow steps
    const startTraining = new tasks.LambdaInvoke(this, 'StartTrainingJob', {
      lambdaFunction: startTrainingLambda,
      outputPath: '$.Payload',
    });

    const checkStatus = new tasks.LambdaInvoke(this, 'CheckTrainingStatus', {
      lambdaFunction: checkTrainingStatusLambda,
      outputPath: '$.Payload',
    });

    const waitForTraining = new sfn.Wait(this, 'WaitForTraining', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(5)),
    });

    const success = new sfn.Succeed(this, 'TrainingSucceeded');
    const fail = new sfn.Fail(this, 'TrainingFailed', {
      cause: 'Training job failed',
      error: 'Training failure',
    });

    // Create workflow definition
    const definition = sfn.Chain
      .start(startTraining)
      .next(waitForTraining)
      .next(checkStatus)
      .next(new sfn.Choice(this, 'IsTrainingComplete')
        .when(sfn.Condition.stringEquals('$.status', 'Completed'), success)
        .when(sfn.Condition.stringEquals('$.status', 'Failed'), fail)
        .otherwise(waitForTraining)  // Continue waiting if still in progress
      );

    // Create state machine
    return new sfn.StateMachine(this, 'ModelRetrainingWorkflow', {
      definition,
      role,
      stateMachineName: `${this.projectPrefix}-model-retraining`,
      timeout: cdk.Duration.hours(12),
    });
  }
}
