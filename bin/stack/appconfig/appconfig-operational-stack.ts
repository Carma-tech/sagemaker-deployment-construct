// bin/stack/appconfig/appconfig-operational-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as logs from 'aws-cdk-lib/aws-logs';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

export class AppConfigOperationalStack extends BaseStack {
  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);

    // Create an AppConfig Application.
    const appConfigApplication = new appconfig.CfnApplication(this, 'AppConfigApplication', {
      name: `${this.projectPrefix}-${stackConfig.ApplicationName}`,
      description: 'Application for dynamic model parameters',
    });

    // Create an AppConfig Environment.
    const appConfigEnvironment = new appconfig.CfnEnvironment(this, 'AppConfigEnvironment', {
      applicationId: appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.EnvironmentName}`,
      description: 'Production environment for dynamic configurations',
    });

    // Create a Deployment Strategy.
    const deploymentStrategy = new appconfig.CfnDeploymentStrategy(this, 'DeploymentStrategy', {
      name: `${this.projectPrefix}-${stackConfig.DeploymentStrategyName}`,
      description: 'Rolling deployment strategy for dynamic configuration updates',
      deploymentDurationInMinutes: stackConfig.DeploymentDurationInMinutes || 10,
      finalBakeTimeInMinutes: 2,
      growthFactor: stackConfig.GrowthFactor || 25,
      replicateTo: 'NONE',
    });

    // Create a Configuration Profile.
    const configurationProfile = new appconfig.CfnConfigurationProfile(this, 'ConfigurationProfile', {
      applicationId: appConfigApplication.ref,
      name: `${this.projectPrefix}-${stackConfig.ConfigurationProfileName}`,
      locationUri: 'hosted',
      type: 'AWS.Freeform',
      validators: [
        {
          type: 'JSON_SCHEMA',
          content: '{ "type": "object" }'
        }
      ],
    });

    // Create a CloudWatch Log Group to capture logs related to configuration deployments.
    const appConfigLogGroup = new logs.LogGroup(this, 'AppConfigLogGroup', {
      logGroupName: `${this.projectPrefix}-AppConfigDeployments`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create a Lambda function to serve predictions.
    const appConfigParameterFetcher = new lambda.Function(this, 'AppConfigParameterFetcher', {
      runtime: lambda.Runtime.PYTHON_3_13,
      code: lambda.Code.fromAsset('codes/lambda/appconfig/parameter-fetcher'),
      handler: 'handler.handler',
      architecture: lambda.Architecture.ARM_64,
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        // iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ],
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['appconfig:GetConfiguration', 'appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'],
      resources: [`arn:aws:appconfig:${this.region}:${this.account}:application/*`],
    }));

    new cdk.CfnOutput(this, 'AppconfigParameterFetcher', {
      value: appConfigParameterFetcher.functionArn,
      exportName: 'AppconfigParameterFetcher'
    });

    new cdk.CfnOutput(this, 'AppConfigApplicationId', {
      value: appConfigApplication.ref,
      description: 'The ID of the AppConfig Application'
    });

    new cdk.CfnOutput(this, 'AppConfigEnvironmentId', {
      value: appConfigEnvironment.ref,
      description: 'The ID of the AppConfig Environment'
    });

    new cdk.CfnOutput(this, 'ConfigurationProfileId', {
      value: configurationProfile.ref,
      description: 'The ID of the AppConfig Configuration Profile'
    });

    new cdk.CfnOutput(this, 'DeploymentStrategyId', {
      value: deploymentStrategy.ref,
      description: 'The ID of the AppConfig Deployment Strategy'
    });

    new cdk.CfnOutput(this, 'AppConfigLogGroupName', {
      value: appConfigLogGroup.logGroupName,
      description: 'The name of the CloudWatch Log Group for AppConfig deployments'
    });

  }
}



