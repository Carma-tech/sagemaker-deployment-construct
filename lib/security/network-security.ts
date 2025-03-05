// lib/security/network-security.ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface NetworkSecurityProps {
  readonly namePrefix: string;
  readonly vpc?: ec2.IVpc;
  readonly existingSecurityGroups?: ec2.ISecurityGroup[];
  readonly enableNetworkIsolation?: boolean;
  readonly allowedIngressCidrs?: string[];
  readonly allowedIngressSecurityGroups?: ec2.ISecurityGroup[];
  readonly subnetType?: ec2.SubnetType;
  readonly createSecurityGroup?: boolean;
}

export class NetworkSecurity extends Construct {
  public readonly securityGroups: ec2.ISecurityGroup[] = [];
  public readonly subnets: ec2.ISubnet[] = [];
  public readonly enableNetworkIsolation: boolean;

  constructor(scope: Construct, id: string, props: NetworkSecurityProps) {
    super(scope, id);

    // Set network isolation flag
    this.enableNetworkIsolation = props.enableNetworkIsolation ?? false;

    // If no VPC is provided, we don't need to configure network security
    if (!props.vpc) {
      return;
    }

    // Get subnets based on subnet type
    const subnetType = props.subnetType || ec2.SubnetType.PRIVATE_WITH_EGRESS;
    this.subnets = this.getSubnets(props.vpc, subnetType);

    // Use existing security groups if provided
    if (props.existingSecurityGroups && props.existingSecurityGroups.length > 0) {
      this.securityGroups = props.existingSecurityGroups;
    } 
    // Create new security group if requested
    else if (props.createSecurityGroup !== false) {
      const sg = this.createSecurityGroup(props);
      this.securityGroups.push(sg);
    }
  }

  private getSubnets(vpc: ec2.IVpc, subnetType: ec2.SubnetType): ec2.ISubnet[] {
    // Get subnets of the specified type
    switch (subnetType) {
      case ec2.SubnetType.PRIVATE_WITH_EGRESS:
        return vpc.privateSubnets;
      case ec2.SubnetType.PRIVATE_ISOLATED:
        return vpc.isolatedSubnets;
      case ec2.SubnetType.PUBLIC:
        return vpc.publicSubnets;
      default:
        return vpc.privateSubnets;
    }
  }

  private createSecurityGroup(props: NetworkSecurityProps): ec2.SecurityGroup {
    if (!props.vpc) {
      throw new Error('VPC must be provided to create a security group');
    }

    // Create security group for SageMaker endpoint
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: `Security group for SageMaker deployment ${props.namePrefix}`,
      allowAllOutbound: true, // SageMaker needs outbound access to download container images and model artifacts
    });

    // Add tags
    cdk.Tags.of(securityGroup).add('Name', `${props.namePrefix}-sagemaker-sg`);
    cdk.Tags.of(securityGroup).add('ManagedBy', 'CDK-SageMaker-Construct');

    // Add ingress rules if provided
    if (props.allowedIngressCidrs && props.allowedIngressCidrs.length > 0) {
      props.allowedIngressCidrs.forEach((cidr, index) => {
        securityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(443),
          `Allow HTTPS access from ${cidr}`
        );
      });
    }

    // Add security group ingress rules if provided
    if (props.allowedIngressSecurityGroups && props.allowedIngressSecurityGroups.length > 0) {
      props.allowedIngressSecurityGroups.forEach((sg, index) => {
        securityGroup.addIngressRule(
          ec2.Peer.securityGroupId(sg.securityGroupId),
          ec2.Port.tcp(443),
          `Allow HTTPS access from security group ${sg.securityGroupId}`
        );
      });
    }

    return securityGroup;
  }

  // Helper to get VPC configuration for SageMaker
  public getVpcConfig(): { securityGroupIds: string[]; subnets: string[] } | undefined {
    if (this.securityGroups.length === 0 || this.subnets.length === 0) {
      return undefined;
    }
  
    return {
      securityGroupIds: this.securityGroups.map(sg => sg.securityGroupId),
      subnets: this.subnets.map(subnet => subnet.subnetId), // Changed from subnetIds to subnets
    };
  }
}