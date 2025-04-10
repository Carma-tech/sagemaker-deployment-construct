#!/usr/bin/env python3
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.storage import S3
from diagrams.aws.ml import Sagemaker, SagemakerModel, SagemakerNotebook
from diagrams.aws.management import Cloudwatch, CloudwatchAlarm
from diagrams.aws.integration import StepFunctions
from diagrams.aws.security import IAM, KMS
from diagrams.aws.compute import Lambda
from diagrams.aws.general import User
from diagrams.aws.devtools import Codebuild
from diagrams.onprem.client import User as Developer
from diagrams.aws.management import SystemsManagerParameterStore as AppConfig

# Set the diagram properties
graph_attr = {
    "fontsize": "20",
    "bgcolor": "white",
    "pad": "0.5"
}

# Create the main diagram
with Diagram("SageMaker CDK Infrastructure Architecture", show=False, graph_attr=graph_attr, filename="sagemaker_cdk_architecture"):
    
    # Create the user/developer node
    user = Developer("User/Developer")
    
    # CDK construct node
    with Cluster("CDK Construct"):
        cdk = Codebuild("CDK Construct")
    
    # Connect user to CDK
    user >> Edge(label="Deploys") >> cdk
    
    # Storage Layer
    with Cluster("Storage Layer"):
        s3_model = S3("Model Artifacts Bucket")
        s3_config = S3("Configuration Files Bucket")
    
    # Configuration Management
    with Cluster("Configuration Management"):
        app_config = AppConfig("AWS AppConfig")
        
        with Cluster("AppConfig Resources"):
            config_profiles = AppConfig("Configuration Profiles")
            config_envs = AppConfig("Environments")
            config_deployments = AppConfig("Deployments")
        
        # Connect AppConfig resources
        app_config >> config_profiles
        app_config >> config_envs
        app_config >> config_deployments
    
    # SageMaker Resources
    with Cluster("SageMaker Resources"):
        sm_model = SagemakerModel("SageMaker Model")
        sm_endpoint_config = Sagemaker("SageMaker Endpoint Configuration")
        sm_endpoint = Sagemaker("SageMaker Endpoint")
        
        with Cluster("Model Variants"):
            sm_variants = SagemakerModel("Model Variants")
        
        # Connect SageMaker resources
        sm_model >> sm_endpoint_config
        sm_endpoint_config >> sm_variants
        sm_endpoint_config >> sm_endpoint
    
    # Monitoring & Logging
    with Cluster("Monitoring & Logging"):
        cw_metrics = Cloudwatch("CloudWatch Metrics")
        cw_alarms = CloudwatchAlarm("CloudWatch Alarms")
        cw_dashboard = Cloudwatch("CloudWatch Dashboard")
        sm_monitoring = Sagemaker("SageMaker Model Monitoring")
        cw_logs = Cloudwatch("CloudWatch Logs")
        
        # Connect monitoring resources
        sm_endpoint >> cw_metrics
        sm_endpoint >> cw_logs
        sm_endpoint >> sm_monitoring
        cw_metrics >> cw_alarms
        cw_metrics >> cw_dashboard
        sm_monitoring >> cw_metrics
    
    # Security & IAM
    with Cluster("Security & IAM"):
        iam_roles = IAM("IAM Roles")
        iam_policies = IAM("IAM Policies")
        kms = KMS("KMS Keys")
        
        # Connect security resources
        iam_policies >> iam_roles
        kms >> Edge(label="Encrypts") >> s3_model
        kms >> Edge(label="Encrypts") >> s3_config
    
    # Optional Integrations
    with Cluster("Optional Integrations"):
        step_functions = StepFunctions("Step Functions")
        lambda_fn = Lambda("Lambda Functions")
        
        # Connect optional integrations
        step_functions >> Edge(style="dashed") >> sm_endpoint
        lambda_fn >> Edge(style="dashed") >> sm_endpoint
    
    # Main connections for CDK
    cdk >> s3_model
    cdk >> s3_config
    cdk >> app_config
    cdk >> sm_model
    cdk >> sm_endpoint_config
    cdk >> sm_endpoint
    cdk >> cw_metrics
    cdk >> cw_alarms
    cdk >> cw_dashboard
    cdk >> sm_monitoring
    cdk >> iam_roles
    cdk >> iam_policies
    cdk >> kms
    cdk >> Edge(style="dashed") >> step_functions
    
    # Storage connections
    s3_model >> Edge(label="Provides artifacts to") >> sm_model
    s3_config >> Edge(label="Provides configs to") >> app_config
    
    # AppConfig connections
    config_deployments >> Edge(label="Updates configs for") >> sm_endpoint
    
    # Security connections
    iam_roles >> Edge(label="Grants permissions to") >> sm_endpoint
    iam_roles >> Edge(label="Grants permissions to") >> app_config