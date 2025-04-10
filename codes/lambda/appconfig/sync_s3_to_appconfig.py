import boto3
import json
import logging
import os
import time
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def handler(event, context):
    """
    Lambda function to sync configuration from S3 to AWS AppConfig.
    
    Expected event structure:
    {
        "bucket": "model-artifacts-bucket",
        "key": "configs/model-config.json",
        "wait_for_deployment": true
    }
    """
    try:
        # Get environment variables
        application_id = os.environ.get('APPLICATION_ID')
        environment_id = os.environ.get('ENVIRONMENT_ID')
        configuration_profile_id = os.environ.get('CONFIGURATION_PROFILE_ID')
        deployment_strategy_id = os.environ.get('DEPLOYMENT_STRATEGY_ID')
        config_bucket = os.environ.get('CONFIG_BUCKET')
        
        # Extract parameters from event
        bucket = event.get('bucket', config_bucket)
        key = event.get('key', 'configs/model-config.json')
        wait_for_deployment = event.get('wait_for_deployment', True)
        
        # Validate required parameters
        if not all([application_id, environment_id, configuration_profile_id, deployment_strategy_id, bucket]):
            missing = []
            if not application_id: missing.append('APPLICATION_ID')
            if not environment_id: missing.append('ENVIRONMENT_ID')
            if not configuration_profile_id: missing.append('CONFIGURATION_PROFILE_ID')
            if not deployment_strategy_id: missing.append('DEPLOYMENT_STRATEGY_ID')
            if not bucket: missing.append('bucket/CONFIG_BUCKET')
            
            error_msg = f"Missing required parameters: {', '.join(missing)}"
            logger.error(error_msg)
            return {
                'statusCode': 400,
                'body': error_msg
            }
        
        # Get configuration content from S3
        s3_client = boto3.client('s3')
        logger.info(f"Fetching configuration from S3: bucket={bucket}, key={key}")
        
        try:
            response = s3_client.get_object(Bucket=bucket, Key=key)
            config_content = response['Body'].read().decode('utf-8')
            config_json = json.loads(config_content)
            logger.info(f"Successfully retrieved configuration from S3 with {len(config_json)} top-level keys")
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.warning(f"Configuration file {key} not found in bucket {bucket}")
                # Try to load model-config.json and model-training-config.json and merge them
                try:
                    # Load model-config.json
                    model_config_response = s3_client.get_object(Bucket=bucket, Key='configs/model-config.json')
                    model_config = json.loads(model_config_response['Body'].read().decode('utf-8'))
                    
                    # Load model-training-config.json
                    training_config_response = s3_client.get_object(Bucket=bucket, Key='configs/model-training-config.json')
                    training_config = json.loads(training_config_response['Body'].read().decode('utf-8'))
                    
                    # Merge configurations
                    if 'modelParameters' in model_config and 'training' in model_config['modelParameters']:
                        model_config['modelParameters']['training'].update(training_config.get('Training', {}))
                    
                    config_json = model_config
                    logger.info("Created merged configuration from model-config.json and model-training-config.json")
                except Exception as merge_error:
                    logger.error(f"Error merging configurations: {str(merge_error)}")
                    return {
                        'statusCode': 500,
                        'body': f"Error merging configurations: {str(merge_error)}"
                    }
            else:
                logger.error(f"Error retrieving configuration from S3: {str(e)}")
                return {
                    'statusCode': 500,
                    'body': f"Error retrieving configuration from S3: {str(e)}"
                }
        
        # Initialize AppConfig client
        appconfig_client = boto3.client('appconfig')
        
        # Create a version of the configuration
        logger.info(f"Creating configuration version in AppConfig")
        version_response = appconfig_client.create_hosted_configuration_version(
            ApplicationId=application_id,
            ConfigurationProfileId=configuration_profile_id,
            Content=json.dumps(config_json).encode('utf-8'),
            ContentType='application/json'
        )
        
        version_number = version_response['VersionNumber']
        logger.info(f"Created configuration version {version_number}")
        
        # Start a deployment
        logger.info(f"Starting deployment of configuration version {version_number}")
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
        
        # Wait for deployment to complete if requested
        if wait_for_deployment:
            logger.info(f"Waiting for deployment {deployment_id} to complete")
            max_wait_time = 300  # 5 minutes
            start_time = time.time()
            
            while time.time() - start_time < max_wait_time:
                deployment_status = appconfig_client.get_deployment(
                    ApplicationId=application_id,
                    EnvironmentId=environment_id,
                    DeploymentNumber=deployment_id
                )
                
                status = deployment_status['DeploymentState']
                logger.info(f"Deployment status: {status}")
                
                if status == 'COMPLETE':
                    logger.info("Deployment completed successfully")
                    break
                elif status in ['FAILED', 'ROLLED_BACK']:
                    logger.error(f"Deployment failed with status: {status}")
                    return {
                        'statusCode': 500,
                        'body': f"Deployment failed with status: {status}"
                    }
                
                time.sleep(10)  # Wait 10 seconds before checking again
        
        return {
            'statusCode': 200,
            'body': {
                'versionNumber': version_number,
                'deploymentNumber': deployment_id,
                'configKeys': list(config_json.keys())
            }
        }
        
    except Exception as e:
        logger.error(f"Error syncing configuration: {str(e)}")
        return {
            'statusCode': 500,
            'body': str(e)
        }