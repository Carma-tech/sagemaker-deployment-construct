import json
import os
import boto3
import logging
import traceback

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize AppConfig client
appconfig_client = boto3.client('appconfig')


def handler(event, context):
    """
    Lambda function to fetch configuration parameters from AWS AppConfig.

    Expected event structure:
    {
        "ApplicationId": "abc123",
        "EnvironmentId": "def456",
        "ConfigurationProfileId": "ghi789",
        "ParameterKey": "sageMakerEndpointName",  # Optional - specific parameter to extract
        "RequiredMinimumPollIntervalInSeconds": 30  # Optional
    }

    Or environment variables can be used instead.
    """
    try:
        # Debug log the raw event
        logger.info(f"Raw event received: {json.dumps(event)}")
        
        # Extract parameters from event or environment variables
        application_id = event.get('ApplicationId', os.environ.get('APPLICATION_ID'))
        environment_id = event.get('EnvironmentId', os.environ.get('ENVIRONMENT_ID'))
        configuration_profile_id = event.get('ConfigurationProfileId', os.environ.get('CONFIGURATION_PROFILE_ID'))
        parameter_key = event.get('ParameterKey')
        
        # Handle poll interval conversion robustly
        poll_interval = 30  # default value
        if 'RequiredMinimumPollIntervalInSeconds' in event:
            try:
                poll_interval = int(float(event['RequiredMinimumPollIntervalInSeconds']))
            except (ValueError, TypeError) as e:
                logger.warning(f"Invalid poll interval value: {event['RequiredMinimumPollIntervalInSeconds']}. Using default 30")
                poll_interval = 30
        
        logger.info(f"Using poll interval: {poll_interval} (type: {type(poll_interval)})")
        
        # Log the input parameters for debugging
        logger.info(f"Input parameters: ApplicationId={application_id}, EnvironmentId={environment_id}, ConfigurationProfileId={configuration_profile_id}, ParameterKey={parameter_key}, PollInterval={poll_interval} (type: {type(poll_interval)})")

        # Validate required parameters
        if not all([application_id, environment_id, configuration_profile_id]):
            missing = [p for p in ['ApplicationId', 'EnvironmentId', 'ConfigurationProfileId']
                       if not event.get(p) and not os.environ.get(p.upper())]
            error_msg = f"Missing required parameters: {', '.join(missing)}"
            logger.error(error_msg)
            return {
                'statusCode': 400,
                'body': error_msg
            }

        logger.info(
            f"Fetching configuration from AppConfig: App={application_id}, Env={environment_id}, Profile={configuration_profile_id}")

        # Start a configuration session
        session = appconfig_client.start_configuration_session(
            ApplicationId=application_id,
            EnvironmentId=environment_id,
            ConfigurationProfileId=configuration_profile_id,
            RequiredMinimumPollIntervalInSeconds=poll_interval
        )

        # Get the configuration
        config_response = appconfig_client.get_configuration(
            ConfigurationToken=session['InitialConfigurationToken']
        )

        # Parse the configuration content
        config_content = json.loads(
            config_response['Content'].read().decode('utf-8'))
        logger.info(
            f"Retrieved configuration with keys: {list(config_content.keys())}")

        # If a specific parameter key is requested, extract it
        if parameter_key:
            # Handle nested keys with dot notation (e.g., "modelParameters.training.learningRate")
            if '.' in parameter_key:
                keys = parameter_key.split('.')
                value = config_content
                for key in keys:
                    if key in value:
                        value = value[key]
                    else:
                        logger.error(
                            f"Parameter {parameter_key} not found in configuration. Available keys: {list(config_content.keys())}")
                        return {
                            'statusCode': 404,
                            'body': f"Parameter {parameter_key} not found in configuration"
                        }
                parameter_value = value
            else:
                if parameter_key in config_content:
                    parameter_value = config_content[parameter_key]
                else:
                    logger.error(
                        f"Parameter {parameter_key} not found in configuration. Available keys: {list(config_content.keys())}")
                    return {
                        'statusCode': 404,
                        'body': f"Parameter {parameter_key} not found in configuration"
                    }

            logger.info(
                f"Retrieved parameter {parameter_key} with value: {json.dumps(parameter_value, default=str)}")

            return {
                'statusCode': 200,
                'ParameterValue': parameter_value
            }
        else:
            # Return the entire configuration
            logger.info(
                f"Retrieved full configuration with {len(config_content)} top-level keys")

            return {
                'statusCode': 200,
                'Configuration': config_content
            }

    except Exception as e:
        logger.error(f"Error fetching configuration: {str(e)}")
        logger.error(traceback.format_exc())
        return {
            'statusCode': 500,
            'body': str(e)
        }
