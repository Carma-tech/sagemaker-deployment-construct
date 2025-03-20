import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppConfigOperationalStack } from '../bin/stack/appconfig/appconfig-operational-stack';
import { StackCommonProps } from '../lib/base/base-stack';

// Dummy configuration for AppConfigOperationalStack.
const dummyConfig = {
    DashboardName: "TestAppConfigDashboard",
    BucketBaseName: "appconfig-bucket-base",
    SubscriptionEmails: ["test@example.com"]
};

const stackCommonProps: StackCommonProps = {
    projectPrefix: "TestProjectMLDemo",
    appConfig: {
        Project: {
            Name: "TestProject",
            Stage: "MLTest",
            Account: process.env.CDK_DEFAULT_ACCOUNT,
            Region: process.env.CDK_DEFAULT_REGION
        }
    },
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
};

test('AppConfigOperationalStack creates AppConfig resources and CloudWatch log group', () => {
    const app = new cdk.App();
    const stack = new AppConfigOperationalStack(app, stackCommonProps, dummyConfig);
    const template = Template.fromStack(stack);

    // Verify that an AppConfig Application is created.
    template.hasResourceProperties("AWS::AppConfig::Application", {
        Name: `${stackCommonProps.projectPrefix}-ModelConfigApp`
    });

    // Verify that a CloudWatch Log Group for AppConfig deployments exists.
    template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 7
    });
});
