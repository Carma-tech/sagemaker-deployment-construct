import boto3
import json
import logging
import os
import hashlib
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def handler(event, context):
    """
    Lambda function to deploy configuration from S3 to AWS AppConfig.
    
    Expected event structure:
    {
        "bucket": "model-artifacts-bucket",
        "key": "configs/model-config.json",
        "application_id": "abc123",
        "environment_id": "def456",
        "configuration_profile_id": "ghi789",
        "deployment_strategy_id": "jkl012"
    }
    """
    # Extract parameters from event
    bucket = event.get('bucket')
    key = event.get('key')
    application_id = event.get('application_id')
    environment_id = event.get('environment_id')
    configuration_profile_id = event.get('configuration_profile_id')
    deployment_strategy_id = event.get('deployment_strategy_id')
    
    # Validate required parameters
    if not all([bucket, key, application_id, environment_id, configuration_profile_id, deployment_strategy_id]):
        missing = [p for p in ['bucket', 'key', 'application_id', 'environment_id', 
                              'configuration_profile_id', 'deployment_strategy_id'] 
                  if not event.get(p)]
        error_msg = f"Missing required parameters: {', '.join(missing)}"
        logger.error(error_msg)
        return {
            'statusCode': 400,
            'body': error_msg
        }
    
    try:
        # Get configuration content from S3
        s3_client = boto3.client('s3')
        response = s3_client.get_object(Bucket=bucket, Key=key)
        config_content = response['Body'].read()
        
        # Calculate content hash for version
        content_hash = hashlib.md5(config_content).hexdigest()
        
        # Initialize AppConfig client
        appconfig_client = boto3.client('appconfig')
        
        # Create a version of the configuration
        version_response = appconfig_client.create_hosted_configuration_version(
            ApplicationId=application_id,
            ConfigurationProfileId=configuration_profile_id,
            Content=config_content,
            ContentType='application/json'
        )
        
        version_number = version_response['VersionNumber']
        logger.info(f"Created configuration version {version_number} with hash {content_hash}")
        
        # Start a deployment
        deployment_response = appconfig_client.start_deployment(
            ApplicationId=application_id,
            EnvironmentId=environment_id,
            DeploymentStrategyId=deployment_strategy_id,
            ConfigurationProfileId=configuration_profile_id,
            ConfigurationVersion=str(version_number),
            Description=f"Automated deployment from S3 bucket {bucket}, key {key}"
        )
        
        deployment_id = deployment_response['DeploymentNumber']
        logger.info(f"Started deployment {deployment_id} for configuration version {version_number}")
        
        return {
            'statusCode': 200,
            'body': {
                'versionNumber': version_number,
                'deploymentNumber': deployment_id,
                'contentHash': content_hash
            }
        }
        
    except Exception as e:
        logger.error(f"Error deploying configuration: {str(e)}")
        return {
            'statusCode': 500,
            'body': str(e)
        }