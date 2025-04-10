import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { loadConfig } from '../lib/utils/config-loader';
import { StackCommonProps } from '../lib/base/base-stack';

// Import your stack classes
import { ModelArchivingStack } from './stack/model-serving/model-archiving-stack';
import { ModelServingStack } from './stack/model-serving/model-serving-stack';
import { APIHostingStack } from './stack/api-hosting/api-hosting-stack';
import { MonitorDashboardStack } from './stack/monitor-dashboard/monitor-dashboard-stack';
import { CicdPipelineStack } from './stack/cicd-pipeline/cicd-pipeline-stack';
import { APITestingStack } from './stack/api-testing/api-testing-stack';
import { TesterDashboardStack } from './stack/monitor-dashboard/tester-dashboard-stack';
import { ModelTrainingStack } from './stack/model-serving/model-training-stack';
import { ModelTransformJobStack } from './stack/model-serving/model-transform-stack';
import { GlueJobStack } from './stack/model-serving/glue-stack';
import { SecurityOperationalEnhancementsStack } from './stack/security/security-operational-enhancements-stack';
import { ModelWorkflowStack } from './stack/step-functions/model-workflow-stack';
import { AppConfigOperationalStack } from './stack/appconfig/appconfig-operational-stack';


(async () => {
  // Load configuration from S3 if available, otherwise from local file.
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

  new AppConfigOperationalStack(cdkApp, stackCommonProps, appConfig.Stack.AppConfigOperational);
  // new ModelTrainingStack(cdkApp, stackCommonProps, appConfig.Stack.ModelTraining);
  new ModelArchivingStack(cdkApp, stackCommonProps, appConfig.Stack.ModelArchiving);
  const modelServingStack = new ModelServingStack(cdkApp, stackCommonProps, appConfig.Stack.ModelServing);
  // new ModelTransformJobStack(cdkApp, stackCommonProps, appConfig.Stack.ModelTransformJob);
  new APIHostingStack(cdkApp, stackCommonProps, appConfig.Stack.APIHosting);
  const monitorDashboardStack = new MonitorDashboardStack(cdkApp, stackCommonProps, appConfig.Stack.MonitorDashboard);
  // new CicdPipelineStack(cdkApp, stackCommonProps, appConfig.Stack.CICDPipeline);
  new APITestingStack(cdkApp, stackCommonProps, appConfig.Stack.APITesting);
  new TesterDashboardStack(cdkApp, stackCommonProps, appConfig.Stack.TesterDashboard);
  // new GlueJobStack(cdkApp, 'GlueJobStack', stackCommonProps);
  new SecurityOperationalEnhancementsStack(cdkApp, stackCommonProps, appConfig.Stack.SecurityOperationalEnhancements);
  new ModelWorkflowStack(cdkApp, stackCommonProps, appConfig.Stack.ModelWorkflow);

  // Ensure the model serving stack deploys first so that the SSM parameter is created.
  monitorDashboardStack.node.addDependency(modelServingStack);
})();
