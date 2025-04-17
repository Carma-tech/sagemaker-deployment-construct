import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

/**
 * Properties for the SageMakerDeploymentConstruct
 */
export interface SageMakerDeploymentConstructProps {
  /**
   * Prefix for resource naming
   */
  prefix: string;
  
  /**
   * S3 bucket containing model artifacts
   */
  modelArtifactBucket: s3.IBucket;
  
  /**
   * S3 key for the model artifact
   */
  modelArtifactPath?: string;
  
  /**
   * AppConfig application ID for configuration
   */
  appConfigApplicationId: string;
  
  /**
   * AppConfig environment ID for configuration
   */
  appConfigEnvironmentId: string;
  
  /**
   * AppConfig configuration profile ID for configuration
   */
  appConfigConfigurationProfileId: string;
  
  /**
   * Function to fetch parameters from AppConfig
   */
  appConfigFetcherFunction: lambda.IFunction;
  
  /**
   * IAM role for AppConfig parameter fetcher
   */
  appConfigFetcherRole: iam.IRole;
  
  /**
   * Whether to create a single endpoint with multiple variants or separate endpoints per model
   * @default false (separate endpoints)
   */
  singleEndpointWithVariants?: boolean;
  
  /**
   * Whether to enable model monitoring
   * @default true
   */
  enableModelMonitoring?: boolean;
  
  /**
   * Email addresses for monitoring alerts
   */
  alertEmails?: string[];
  
  /**
   * Additional tags to apply to resources
   */
  tags?: { [key: string]: string };
}

/**
 * A CDK construct that creates a SageMaker deployment with AppConfig integration for model serving
 */
export class SageMakerDeploymentConstruct extends Construct {
  /**
   * The SageMaker models created by this construct
   */
  public readonly models: sagemaker.CfnModel[] = [];
  
  /**
   * The SageMaker endpoint configuration created by this construct
   */
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;
  
  /**
   * The SageMaker endpoint created by this construct
   */
  public readonly endpoint: sagemaker.CfnEndpoint;
  
  /**
   * The execution role for SageMaker
   */
  public readonly executionRole: iam.Role;
  
  /**
   * The CloudWatch dashboard for monitoring
   */
  public monitoringDashboard: cloudwatch.Dashboard;
  
  /**
   * CloudWatch alarms created for monitoring
   */
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: SageMakerDeploymentConstructProps) {
    super(scope, id);

    const prefix = props.prefix;
    
    // Create AppConfig parameter provider for dynamic configuration
    const appConfigProvider = new cr.Provider(this, 'AppConfigProvider', {
      onEventHandler: props.appConfigFetcherFunction,
      role: props.appConfigFetcherRole,
    });
    
    // Get model configuration from AppConfig
    const modelListResource = new cdk.CustomResource(this, 'ModelListConfig', {
      serviceToken: appConfigProvider.serviceToken,
      properties: {
        ApplicationId: props.appConfigApplicationId,
        EnvironmentId: props.appConfigEnvironmentId,
        ConfigurationProfileId: props.appConfigConfigurationProfileId,
        RequiredMinimumPollIntervalInSeconds: '30',
        ParameterKey: 'modelList'
      },
    });
    
    // Parse model configuration
    const modelList = JSON.parse(modelListResource.getAttString('ParameterValue') || '[]');
    
    // Create SageMaker execution role
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `${prefix}-SageMakerExecutionRole`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
      inlinePolicies: {
        ModelAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:ListBucket',
              ],
              resources: [
                props.modelArtifactBucket.bucketArn,
                `${props.modelArtifactBucket.bucketArn}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "appconfig:GetConfiguration",
                "appconfig:GetLatestConfiguration",
                "appconfig:StartConfigurationSession",
              ],
              resources: [`arn:aws:appconfig:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudwatch:PutMetricData",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:CreateLogGroup",
                "logs:DescribeLogStreams",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    
    // Grant read access to the model artifact bucket
    props.modelArtifactBucket.grantRead(this.executionRole);
    
    // Create SageMaker models and endpoints based on configuration
    const productionVariants: sagemaker.CfnEndpointConfig.ProductionVariantProperty[] = [];
    
    for (const modelConfig of modelList) {
      // Create a SageMaker model
      const model = new sagemaker.CfnModel(this, `Model-${modelConfig.ModelName}`, {
        modelName: `${prefix}-${modelConfig.ModelName}`,
        executionRoleArn: this.executionRole.roleArn,
        primaryContainer: {
          image: modelConfig.ModelDockerImage,
          modelDataUrl: `s3://${props.modelArtifactBucket.bucketName}/${modelConfig.ModelS3Key}`,
          environment: {
            SAGEMAKER_MODEL_SERVER_WORKERS: modelConfig.ModelServerWorkers?.toString() || "1",
            SAGEMAKER_MODEL_SERVER_TIMEOUT: "3600",
            SAGEMAKER_DEFAULT_INVOCATIONS_TIMEOUT: "3600",
            // Add environment variables for AppConfig integration
            APPCONFIG_APPLICATION_ID: props.appConfigApplicationId,
            APPCONFIG_ENVIRONMENT_ID: props.appConfigEnvironmentId,
            APPCONFIG_CONFIGURATION_PROFILE_ID: props.appConfigConfigurationProfileId,
          },
        },
      });
      
      this.models.push(model);
      
      // If using separate endpoints per model
      if (!props.singleEndpointWithVariants) {
        // Create an endpoint configuration for each model
        const endpointConfig = new sagemaker.CfnEndpointConfig(this, `EndpointConfig-${modelConfig.ModelName}`, {
          endpointConfigName: `${prefix}-${modelConfig.ModelName}-config`,
          productionVariants: [
            {
              modelName: model.attrModelName,
              variantName: modelConfig.VariantName || 'AllTraffic',
              initialVariantWeight: 1.0,
              initialInstanceCount: modelConfig.InstanceCount || 1,
              instanceType: modelConfig.InstanceType || 'ml.m5.large',
            },
          ],
        });
        
        // Create an endpoint for each model
        const endpoint = new sagemaker.CfnEndpoint(this, `Endpoint-${modelConfig.ModelName}`, {
          endpointName: `${prefix}-${modelConfig.ModelName}`,
          endpointConfigName: endpointConfig.attrEndpointConfigName,
        });
        
        // Create monitoring for each endpoint
        if (props.enableModelMonitoring !== false) {
          this.setupMonitoring(endpoint.attrEndpointName, modelConfig.VariantName || 'AllTraffic', prefix);
        }
      } else {
        // Add variant to the list for a single endpoint with multiple variants
        productionVariants.push({
          modelName: model.attrModelName,
          variantName: modelConfig.VariantName,
          initialVariantWeight: modelConfig.VariantWeight || 1.0,
          initialInstanceCount: modelConfig.InstanceCount || 1,
          instanceType: modelConfig.InstanceType || 'ml.m5.large',
        });
      }
    }
    
    // If using a single endpoint with multiple variants
    if (props.singleEndpointWithVariants && productionVariants.length > 0) {
      // Create a single endpoint configuration with all variants
      this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
        endpointConfigName: `${prefix}-config`,
        productionVariants: productionVariants,
      });
      
      // Create a single endpoint with all variants
      this.endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
        endpointName: `${prefix}-endpoint`,
        endpointConfigName: this.endpointConfig.attrEndpointConfigName,
      });
      
      // Create monitoring for the single endpoint
      if (props.enableModelMonitoring !== false) {
        this.setupMonitoring(this.endpoint.attrEndpointName, null, prefix);
      }
      
      // Store the endpoint name in AppConfig
      new cdk.CustomResource(this, 'StoreEndpointNameInAppConfig', {
        serviceToken: appConfigProvider.serviceToken,
        properties: {
          ApplicationId: props.appConfigApplicationId,
          EnvironmentId: props.appConfigEnvironmentId,
          ConfigurationProfileId: props.appConfigConfigurationProfileId,
          RequiredMinimumPollIntervalInSeconds: '30',
          ParameterKey: 'sageMakerEndpointName',
          ParameterValue: this.endpoint.attrEndpointName
        },
      });
    }
    
    // Add tags to all resources
    if (props.tags) {
      Object.entries(props.tags).forEach(([key, value]) => {
        cdk.Tags.of(this).add(key, value);
      });
    }
  }
  
  /**
   * Set up monitoring and alarms for the SageMaker endpoint
   */
  private setupMonitoring(endpointName: string, variantName: string | null, prefix: string): void {
    // Create a CloudWatch dashboard for the endpoint
    this.monitoringDashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${prefix}-SageMakerMonitoring`,
    });
    
    // Create widgets for the dashboard
    
    // Instance metrics (CPU, Memory, Disk)
    const instanceMetrics = [
      new cloudwatch.Metric({
        namespace: '/aws/sagemaker/Endpoints',
        metricName: 'CPUUtilization',
        dimensionsMap: variantName ? { 
          EndpointName: endpointName,
          VariantName: variantName
        } : { EndpointName: endpointName },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      new cloudwatch.Metric({
        namespace: '/aws/sagemaker/Endpoints',
        metricName: 'MemoryUtilization',
        dimensionsMap: variantName ? { 
          EndpointName: endpointName,
          VariantName: variantName
        } : { EndpointName: endpointName },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      new cloudwatch.Metric({
        namespace: '/aws/sagemaker/Endpoints',
        metricName: 'DiskUtilization',
        dimensionsMap: variantName ? { 
          EndpointName: endpointName,
          VariantName: variantName
        } : { EndpointName: endpointName },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
    ];
    
    this.monitoringDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Instance Utilization',
        left: instanceMetrics,
        width: 12,
      })
    );
    
    // Latency metrics
    const modelLatency = new cloudwatch.Metric({
      namespace: '/aws/sagemaker/Endpoints',
      metricName: 'ModelLatency',
      dimensionsMap: variantName ? { 
        EndpointName: endpointName,
        VariantName: variantName
      } : { EndpointName: endpointName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    
    const overheadLatency = new cloudwatch.Metric({
      namespace: '/aws/sagemaker/Endpoints',
      metricName: 'OverheadLatency',
      dimensionsMap: variantName ? { 
        EndpointName: endpointName,
        VariantName: variantName
      } : { EndpointName: endpointName },
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });
    
    this.monitoringDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Inference Latency',
        left: [modelLatency, overheadLatency],
        width: 12,
      })
    );
    
    // Invocation metrics
    const invocations = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocations',
      dimensionsMap: variantName ? { 
        EndpointName: endpointName,
        VariantName: variantName
      } : { EndpointName: endpointName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    
    this.monitoringDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Inference Throughput',
        left: [invocations],
        width: 12,
      })
    );
    
    // Error metrics
    const error4xx = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocation4XXErrors',
      dimensionsMap: variantName ? { 
        EndpointName: endpointName,
        VariantName: variantName
      } : { EndpointName: endpointName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    
    const error5xx = new cloudwatch.Metric({
      namespace: 'AWS/SageMaker',
      metricName: 'Invocation5XXErrors',
      dimensionsMap: variantName ? { 
        EndpointName: endpointName,
        VariantName: variantName
      } : { EndpointName: endpointName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
    });
    
    this.monitoringDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Inference Errors',
        left: [error4xx, error5xx],
        width: 12,
      })
    );
    
    // Create alarms
    
    // Latency alarm
    const latencyAlarm = new cloudwatch.Alarm(this, 'LatencyAlarm', {
      metric: modelLatency,
      threshold: 1000, // 1000ms latency threshold
      evaluationPeriods: 3,
      alarmDescription: `High model latency detected for ${endpointName}`,
      alarmName: `${prefix}-${endpointName}-HighLatency`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    this.alarms.push(latencyAlarm);
    
    // Error rate alarm
    const errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      metric: error5xx,
      threshold: 5, // 5 errors
      evaluationPeriods: 3,
      alarmDescription: `High error rate detected for ${endpointName}`,
      alarmName: `${prefix}-${endpointName}-HighErrorRate`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    this.alarms.push(errorAlarm);
    
    // Add alarm widgets to dashboard
    this.monitoringDashboard.addWidgets(
      new cloudwatch.AlarmWidget({
        title: 'Latency Alarm',
        alarm: latencyAlarm,
        width: 6,
      }),
      new cloudwatch.AlarmWidget({
        title: 'Error Rate Alarm',
        alarm: errorAlarm,
        width: 6,
      })
    );
  }
}