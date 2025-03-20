// bin/stack/model-serving/model-serving-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as cr from 'aws-cdk-lib/custom-resources';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

interface ModelProps {
  modelName: string;
  role: iam.IRole;
  modelBucketName: string;
  modelS3Key: string;
  modelDockerImage: string;
  modelServerWorkers: string;
}

interface VariantConfigProps {
  variantName: string;
  variantWeight: number;
  modelName: string;
  instanceCount?: number;
  instanceType?: string;
  serverlessConfig?: sagemaker.CfnEndpointConfig.ServerlessConfigProperty;
}

interface EndpointConfigProps {
  endpointConfigName: string;
  role: iam.IRole;
  variantConfigPropsList: VariantConfigProps[];
  asyncInferenceConfig?: sagemaker.CfnEndpointConfig.AsyncInferenceConfigProperty;
}

interface EndpointProps {
  endpointName: string;
  endpointConfigName: string;
}

export class ModelServingStack extends BaseStack {
  private readonly appConfig: any;

  constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
    super(scope, stackConfig.Name, props, stackConfig);
    this.appConfig = stackConfig.AppConfig;

    // Instead of reading from SSM, fetch the external bucket name from AppConfig.
    // const appConfigParameterFetcher = new iam.Role(this, 'AppConfigFetcherRole', {
    //   roleName: `${this.projectPrefix}-AppConfigFetcherRole`,
    //   assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    // });

    const dynamicConfig = this.commonProps.appConfig.DynamicConfig;

    // Import appconfig fetcher lambda from appconfig stack
    // Import the AppConfig parameter fetcher lambda using fromFunctionAttributes with sameEnvironment flag.
    const appConfigParameterFetcher = lambda.Function.fromFunctionAttributes(this,
      'AppconfigParameterFetcherRole',
      {
        functionArn: cdk.Fn.importValue('AppconfigParameterFetcher'),
        sameEnvironment: true,
      }
    );
    const provider = new cr.Provider(this, 'AppConfigParameterProvider', {
      onEventHandler: appConfigParameterFetcher,
    });

    // Fetch the model artifact bucket name from AppConfig.
    const dynamicBucketResource = new cdk.CustomResource(this, 'ModelArtifactBucketParameter', {
      serviceToken: provider.serviceToken,
      properties: {
        ApplicationId: dynamicConfig.ApplicationId,
        EnvironmentId: dynamicConfig.EnvironmentId,
        ConfigurationProfileId: dynamicConfig.ConfigurationProfileId,
        ClientId: 'client-1',
        ParameterKey: 'modelArtifactBucketName'
      },
    });
    const modelBucketName = dynamicBucketResource.getAttString('ParameterValue');

    const role: iam.IRole = this.createIamRole(`ModelEndpoint-Role`);

    let modelConfigList: VariantConfigProps[] = [];
    const modelList: any[] = stackConfig.ModelList;

    for (let model of modelList) {
      const createdModelName = this.createModel({
        modelName: model.ModelName,
        modelDockerImage: model.ModelDockerImage,
        modelS3Key: model.ModelS3Key,
        modelBucketName: modelBucketName,
        role: role,
        modelServerWorkers: model.ModelServerWorkers,
      });

      modelConfigList.push({
        modelName: createdModelName,
        variantName: model.VariantName,
        variantWeight: model.VariantWeight,
        instanceCount: model.InstanceCount,
        instanceType: model.InstanceType,
      });
    }

    const asyncConfig: sagemaker.CfnEndpointConfig.AsyncInferenceConfigProperty = {
      outputConfig: {
        s3OutputPath: `s3://${modelBucketName}/model/async-output/`,
      },
    };

    const endpointConfigName = this.createEndpointConfig({
      endpointConfigName: stackConfig.EndpointConfigName,
      variantConfigPropsList: modelConfigList,
      role: role,
      asyncInferenceConfig: asyncConfig,
    });

    let endpointName = ' ';
    if (stackConfig.Deploy) {
      endpointName = this.deployEndpoint({
        endpointName: stackConfig.EndpointName,
        endpointConfigName: endpointConfigName,
      });
    }
    // Instead of saving to SSM, you can export as CloudFormation Output or use a custom resource.
    new cdk.CfnOutput(this, 'SageMakerEndpointName', {
      value: endpointName,
      description: 'SageMaker Endpoint Name retrieved via AppConfig dynamic parameter',
    });
  }

  private createModel(props: ModelProps): string {
    const model = new sagemaker.CfnModel(this, `${props.modelName}-Model`, {
      modelName: `${this.projectPrefix}-${props.modelName}-Model`,
      executionRoleArn: props.role.roleArn,
      containers: [
        {
          image: props.modelDockerImage,
          modelDataUrl: `s3://${props.modelBucketName}/${props.modelS3Key}`,
          environment: {
            SAGEMAKER_MODEL_SERVER_WORKERS: props.modelServerWorkers,
            SAGEMAKER_MODEL_SERVER_TIMEOUT: "3600",
            SAGEMAKER_DEFAULT_INVOCATIONS_TIMEOUT: "3600",
          },
        },
      ],
    });
    return model.attrModelName;
  }

  private createEndpointConfig(props: EndpointConfigProps): string {
    const productionVariants = props.variantConfigPropsList.map(modelConfig => ({
      modelName: modelConfig.modelName,
      variantName: modelConfig.variantName,
      initialVariantWeight: modelConfig.variantWeight,
      instanceType: modelConfig.instanceType,
      initialInstanceCount: modelConfig.instanceCount,
      ...(modelConfig.serverlessConfig ? { serverlessConfig: modelConfig.serverlessConfig } : {}),
    }));

    const endpointConfig = new sagemaker.CfnEndpointConfig(this, `${props.endpointConfigName}-Config`, {
      endpointConfigName: `${this.projectPrefix}-${props.endpointConfigName}-Config`,
      productionVariants: productionVariants,
      ...(props.asyncInferenceConfig ? { asyncInferenceConfig: props.asyncInferenceConfig } : {}),
    });

    return endpointConfig.attrEndpointConfigName;
  }

  private deployEndpoint(props: EndpointProps): string {
    const endpointName = `${this.projectPrefix}-${props.endpointName}-Endpoint`;
    new sagemaker.CfnEndpoint(this, `${props.endpointName}-Endpoint`, {
      endpointName: endpointName,
      endpointConfigName: props.endpointConfigName,
    });
    return endpointName;
  }

  private createIamRole(roleBaseName: string): iam.IRole {
    const role = new iam.Role(this, roleBaseName, {
      roleName: `${this.projectPrefix}-${roleBaseName}`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        { managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess' },
      ],
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudwatch:PutMetricData",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:CreateLogGroup",
                "logs:DescribeLogStreams",
                "ec2:CreateNetworkInterface",
                "ec2:CreateNetworkInterfacePermission",
                "ec2:DeleteNetworkInterface",
                "ec2:DeleteNetworkInterfacePermission",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeVpcs",
                "ec2:DescribeDhcpOptions",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups"
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    role.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess' });
    return role;
  }
}
