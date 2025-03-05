// lib/deployment-strategy-factory.ts
import { IDeploymentStrategy, DeploymentStrategyProps } from './deployment-strategy';
import { SingleEndpointStrategy } from './single-endpoint-strategy';
import { MultiVariantStrategy } from './multi-variant-strategy';

export enum DeploymentType {
  SINGLE_MODEL = 'SINGLE_MODEL',
  MULTI_VARIANT = 'MULTI_VARIANT',
}

export class DeploymentStrategyFactory {
  public static createStrategy(
    type: DeploymentType, 
    props: DeploymentStrategyProps
  ): IDeploymentStrategy {
    switch (type) {
      case DeploymentType.SINGLE_MODEL:
        return new SingleEndpointStrategy(props);
      case DeploymentType.MULTI_VARIANT:
        return new MultiVariantStrategy(props);
      default:
        throw new Error(`Unsupported deployment type: ${type}`);
    }
  }
}