import json
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    logger.info("Received event: " + json.dumps(event))
    
    props = event.get('ResourceProperties', {})
    application_id = props.get('ApplicationId')
    environment_id = props.get('EnvironmentId')
    configuration_profile_id = props.get('ConfigurationProfileId')
    client_id = props.get('ClientId')
    parameter_key = props.get('ParameterKey')

    client = boto3.client('appconfigdata')
    
    try:
        # Start a configuration session to obtain a token.
        session_response = client.start_configuration_session(
            ApplicationIdentifier=application_id,
            EnvironmentIdentifier=environment_id,
            ConfigurationProfileIdentifier=configuration_profile_id,
            ClientIdentifier=client_id,
            RequiredMinimumPollIntervalInSeconds=30  # optional, adjust as needed
        )
        logger.info("Session response: " + json.dumps(session_response))
        
        token = session_response.get('InitialConfigurationToken')
        if not token:
            raise Exception("Failed to obtain InitialConfigurationToken.")
        
        # Now call get_latest_configuration with only the token.
        response = client.get_latest_configuration(
            ConfigurationToken=token
        )
        logger.info("Get latest configuration response: " + json.dumps(response, default=str))
        
        config_bytes = response.get('Configuration')
        if config_bytes is not None:
            config_str = config_bytes.decode('utf-8')
        else:
            config_str = '{}'
        logger.info("Configuration string: " + config_str)
        
        config = json.loads(config_str)
        parameter_value = str(config.get(parameter_key, ''))
        logger.info(f"Returning parameter {parameter_key} value: {parameter_value}")
        
        return {
            'PhysicalResourceId': f"AppConfigParameter-{parameter_key}",
            'Data': {
                'ParameterValue': parameter_value
            }
        }
    except Exception as e:
        logger.error("Error retrieving configuration: " + str(e))
        raise e
