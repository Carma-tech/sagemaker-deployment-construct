// bin/stack/api-hosting/api-hosting-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { BaseStack, StackCommonProps } from '../../../lib/base/base-stack';
import { Construct } from 'constructs';

interface PredictLambdaProps {
    name: string;
    // Instead of passing endpointName directly, we'll fetch it dynamically.
}

export class APIHostingStack extends BaseStack {
    private readonly appConfig: any;

    constructor(scope: Construct, props: StackCommonProps, stackConfig: any) {
        super(scope, stackConfig.Name, props, stackConfig);
        this.appConfig = stackConfig.AppConfig;

        const gatewayName = this.stackConfig.APIGatewayName;
        const restApi = this.createAPIGateway(gatewayName);
        this.putParameter('apiGatewayName', `${this.projectPrefix}-${gatewayName}`);
        this.putParameter('apiGatewayId', restApi.restApiId);
        this.putParameter('apiEndpoint', this.getApiEndpoint(restApi));


        const dynamicConfig = this.commonProps.appConfig.DynamicConfig;

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

        const dynamicParameterResource = new cdk.CustomResource(this, 'SageMakerEndpointParameter', {
            serviceToken: provider.serviceToken,
            properties: {
                ApplicationId: dynamicConfig.ApplicationId,
                EnvironmentId: dynamicConfig.EnvironmentId,
                ConfigurationProfileId: dynamicConfig.ConfigurationProfileId,
                ClientId: 'client-1',
                ParameterKey: 'sageMakerEndpointName'
            },
        });
        const sageMakerEndpoint = dynamicParameterResource.getAttString('ParameterValue');

        this.addServiceResource(
            restApi,
            this.stackConfig.ResourceName,
            this.stackConfig.ResourceMethod,
            this.stackConfig.LambdaFunctionName,
            sageMakerEndpoint  // Pass the dynamic endpoint value to the Lambda.
        );
    }

    private createAPIGateway(gatewayName: string): apigateway.RestApi {
        const gateway = new apigateway.RestApi(this, gatewayName, {
            restApiName: `${this.projectPrefix}-${gatewayName}`,
            endpointTypes: [apigateway.EndpointType.REGIONAL],
            description: "This is an API-Gateway for Text Classification Service.",
            retainDeployments: true,
            deploy: true,
            deployOptions: {
                stageName: this.commonProps.appConfig.Project.Stage,
                loggingLevel: apigateway.MethodLoggingLevel.ERROR
            },
        });

        const apiKey = gateway.addApiKey('ApiKey', {
            apiKeyName: `${this.projectPrefix}-${gatewayName}-Key`,
        });

        const plan = gateway.addUsagePlan('APIUsagePlan', {
            name: `${this.projectPrefix}-${gatewayName}-Plan`,
        });
        plan.addApiKey(apiKey);
        plan.addApiStage({
            stage: gateway.deploymentStage,
        });

        return gateway;
    }

    private getApiEndpoint(restApi: apigateway.RestApi): string {
        const region = this.commonProps.env?.region;
        return `${restApi.restApiId}.execute-api.${region}.amazonaws.com`;
    }

    private addServiceResource(gateway: apigateway.RestApi, resourceName: string, resourceMethod: string, functionName: string, sageMakerEndpoint: string) {
        const resource = gateway.root.addResource(resourceName);

        const lambdaFunction = this.createPredictLambdaFunction({
            name: functionName,
            sageMakerEndpoint: sageMakerEndpoint
        });
        this.putParameter('predictLambdaFunctionArn', lambdaFunction.functionArn);
        const lambdaInferAlias = lambdaFunction.addAlias(this.commonProps.appConfig.Project.Stage, {
            // provisionedConcurrentExecutions: 1
        });

        const name = 'PredictLambdaIntegration';
        const role = new iam.Role(this, `${name}-Role`, {
            roleName: `${this.projectPrefix}-${name}-Role`,
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        });
        role.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess' });

        const lambdaIntegration = new apigateway.LambdaIntegration(lambdaInferAlias, {
            credentialsRole: role,
            proxy: false,
            passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_MATCH,
            integrationResponses: [
                {
                    statusCode: '200',
                    responseTemplates: {
                        'application/json': '$input.json("$")'
                    }
                }
            ]
        });

        resource.addMethod(resourceMethod, lambdaIntegration, {
            methodResponses: [{ statusCode: '200' }]
        });
    }

    private createPredictLambdaFunction(props: { name: string; sageMakerEndpoint: string; }) {
        const baseName = `${props.name}-Lambda`;
        const fullName = `${this.projectPrefix}-${baseName}`;

        const lambdaPath = 'codes/lambda/api-hosting-predictor/src';

        const role = new iam.Role(this, `${baseName}-Role`, {
            roleName: `${fullName}-Role`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        role.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' });
        role.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonSageMakerFullAccess' });
        role.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonKinesisFullAccess' });

        const lambdaFunction = new lambda.Function(this, baseName, {
            functionName: fullName,
            code: lambda.Code.fromAsset(lambdaPath),
            handler: 'handler.handle',
            runtime: lambda.Runtime.PYTHON_3_13,
            timeout: cdk.Duration.seconds(60 * 5),
            memorySize: 1024,
            role: role,
            architecture: lambda.Architecture.ARM_64,
            environment: {
                SAGEMAKER_ENDPOINT: props.sageMakerEndpoint,
            },
            currentVersionOptions: {
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                retryAttempts: 1
            }
        });

        return lambdaFunction;
    }
}



