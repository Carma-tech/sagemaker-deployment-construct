import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { loadConfig } from '../lib/utils/config-loader';
import { StackCommonProps } from '../lib/base/base-stack';

// Import stack classes
import { SageMakerBaseInfraStack } from './stack/base/sagemaker-base-infra-stack';
import { AppConfigStack } from './stack/appconfig/appconfig-stack';
import { SageMakerModelStack } from './stack/sagemaker/sagemaker-model-stack';
import { SageMakerEndpointStack } from './stack/sagemaker/sagemaker-endpoint-stack';
import { MonitorDashboardStack } from './stack/monitor-dashboard/monitor-dashboard-stack';

(async () => {
  // Load configuration from S3 if available, otherwise from local file
  const appConfig: any = await loadConfig('config/app-config.json');

  const stackCommonProps: StackCommonProps = {
    projectPrefix: `${appConfig.Project.Name}${appConfig.Project.Stage}`,
    appConfig: appConfig,
    env: {
      account: appConfig.Project.Account,
      region: appConfig.Project.Region,
    },
  };

  const cdkApp = new cdk.App();

  // Deploy stacks in order
  const baseInfraStack = new SageMakerBaseInfraStack(cdkApp, stackCommonProps, appConfig.Stack.BaseInfra);
  
  const appConfigStack = new AppConfigStack(cdkApp, stackCommonProps, {
    ...appConfig.Stack.AppConfig,
    configBucket: baseInfraStack.configBucket,
    encryptionKey: baseInfraStack.encryptionKey,
  });
  appConfigStack.addDependency(baseInfraStack);

  const modelStack = new SageMakerModelStack(cdkApp, stackCommonProps, {
    ...appConfig.Stack.Model,
    modelArtifactBucket: baseInfraStack.modelArtifactBucket,
    baseRole: baseInfraStack.sagemakerBaseRole,
    encryptionKey: baseInfraStack.encryptionKey,
  });
  modelStack.addDependency(baseInfraStack);

  const endpointStack = new SageMakerEndpointStack(cdkApp, stackCommonProps, {
    ...appConfig.Stack.Endpoint,
    modelStack: modelStack,
    appConfigStack: appConfigStack,
    baseRole: baseInfraStack.sagemakerBaseRole,
  });
  endpointStack.addDependency(modelStack);
  endpointStack.addDependency(appConfigStack);

  const monitoringStack = new MonitorDashboardStack(cdkApp, stackCommonProps, {
    ...appConfig.Stack.MonitorDashboard,
    endpointStack: endpointStack,
  });
  monitoringStack.addDependency(endpointStack);
})();
