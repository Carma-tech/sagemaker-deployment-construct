import boto3
import json
import logging
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def handler(event, context):
    # Get bucket name from environment variables or event
    bucket_name = event.get('bucket_name', os.environ.get('CONFIG_BUCKET_NAME'))
    config_key = event.get('config_key', os.environ.get('CONFIG_KEY', 'configs/model-training-config.json'))
    
    if not bucket_name:
        raise ValueError("Bucket name must be provided in event or as environment variable")
    
    # Load JSON configuration from S3
    s3_client = boto3.client('s3')
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=config_key)
        config_content = response['Body'].read().decode('utf-8')
        config = json.loads(config_content)
        logger.info(f"Loaded config from s3://{bucket_name}/{config_key}")
    except Exception as e:
        logger.error(f"Error loading config from S3: {str(e)}")
        raise
    
    logger.info(f"Config: {config}")
    
    # Extract parameters from JSON file
    training_params = config['Training']['Parameters']
    resources = config['Training']['Resources']
    container = config['Training']['Container']
    output = config['Training']['Output']

    # Define S3 paths for input/output data
    s3_prefix = output['s3_path_prefix']

    # Determine version number by listing objects in S3
    response = s3_client.list_objects_v2(Bucket=bucket_name, Prefix=s3_prefix)

    versions = [int(obj['Key'].split('/')[-2][1:])
                for obj in response.get('Contents', []) if 'v' in obj['Key']]
    next_version = max(versions) + 1 if versions else 1

    output_s3_uri = f"s3://{bucket_name}/{s3_prefix}/v{next_version}/"

    # Initialize SageMaker client
    sagemaker_client = boto3.client('sagemaker')

    # Create SageMaker training job
    response = sagemaker_client.create_training_job(
        TrainingJobName=f"{config['Training']['JobNamePrefix']}-v{next_version}",
        AlgorithmSpecification={
            "TrainingImage": container['image'],
            "TrainingInputMode": "File",
        },
        RoleArn=event.get('role_arn', os.environ.get('SAGEMAKER_ROLE_ARN')),
        OutputDataConfig={"S3OutputPath": output_s3_uri},
        ResourceConfig={
            "InstanceType": resources['instance_type'],
            "InstanceCount": resources['instance_count'],
            "VolumeSizeInGB": resources['volume_size_gb'],
        },
        StoppingCondition={
            "MaxRuntimeInSeconds": resources['max_runtime_seconds']},
        HyperParameters={
            "dataset": training_params['dataset'],
            "device": training_params['device'],
            "num_epochs": str(training_params['num_epochs']),
            "batch_size": str(training_params['batch_size']),
            "embed_dim": str(training_params['embed_dim']),
            "learning_rate": str(training_params['learning_rate']),
            "save_model_path": training_params['save_model_path'],
            "dictionary_path": training_params['dictionary_path'],
        },
        Environment={
            'SAGEMAKER_PROGRAM': 'train.py',
            'SAGEMAKER_REGION': os.environ.get('AWS_REGION', 'us-east-1')
        }
    )

    return {
        "statusCode": 200, 
        "body": {
            "trainingJobName": f"{config['Training']['JobNamePrefix']}-v{next_version}",
            "outputS3Uri": output_s3_uri,
            "version": next_version,
            "response": response
        }
    }
