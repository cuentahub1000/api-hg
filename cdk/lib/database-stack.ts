import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { EnvConfig, SSM_ROOT, isPresent } from './config';

export interface DatabaseStackProps extends StackProps {
  readonly cfg: EnvConfig;
}

export interface DatabaseSizing {
  readonly minAcu: number;
  readonly maxAcu: number;
  readonly deletionProtection: boolean;
  readonly backupDays: number;
}

const DEFAULT_SIZING: DatabaseSizing = { minAcu: 0.5, maxAcu: 2, deletionProtection: false, backupDays: 7 };

/**
 * The payments service's own store: one Aurora Serverless v2 Postgres cluster
 * `<env>-hg-postgres`, database `payments`, TLS enforced, credential
 * generated into `<env>/HgDatabase/postgres`. Nothing else uses it and
 * it reaches nothing else. Endpoint, port, name, secret name and security
 * group id are published to SSM so the function stacks need no CFN export.
 *
 * Sizing per environment from `cdk.json` context `paymentsDatabase.<env>`
 * (defaults: 0.5–2 ACU, 7 days of backups, no deletion protection).
 */
export class DatabaseStack extends Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const env = cfg.envName;
    const sizing: DatabaseSizing = { ...DEFAULT_SIZING, ...((this.node.tryGetContext('paymentsDatabase') ?? {})[env] ?? {}) };

    if (!isPresent(cfg.vpcId)) throw new Error(`/${env}/VpcId is not set; the payments database needs the platform VPC`);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: cfg.vpcId });
    const subnets = cfg.privateSubnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(this, `PrivateSubnet${i + 1}`, sid));
    if (subnets.length < 2) throw new Error('the payments database needs /<env>/PrivateSubnet1 and PrivateSubnet2');

    const sg = new ec2.SecurityGroup(this, 'PostgresSg', { vpc, description: `${env} payments postgres`, allowAllOutbound: false });

    const engine = rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_13 });
    const parameterGroup = new rds.ParameterGroup(this, 'PostgresParams', {
      engine, description: `${env} payments postgres`, parameters: { 'rds.force_ssl': '1' },
    });
    const cluster = new rds.DatabaseCluster(this, 'Postgres', {
      clusterIdentifier: `${env}-hg-postgres`,
      engine,
      parameterGroup,
      vpc,
      vpcSubnets: { subnets },
      securityGroups: [sg],
      serverlessV2MinCapacity: sizing.minAcu,
      serverlessV2MaxCapacity: sizing.maxAcu,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      credentials: rds.Credentials.fromGeneratedSecret('payments', { secretName: cfg.dbSecretName }),
      defaultDatabaseName: 'payments',
      storageEncrypted: true,
      backup: { retention: Duration.days(sizing.backupDays) },
      deletionProtection: sizing.deletionProtection,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    const root = SSM_ROOT(env);
    const publish = (name: string, value: string, description: string) =>
      new StringParameter(this, `${name}Param`, { parameterName: `${root}/${name}`, stringValue: value, description });
    publish('db-host', cluster.clusterEndpoint.hostname, 'payments postgres writer endpoint');
    publish('db-port', cluster.clusterEndpoint.port.toString(), 'payments postgres port');
    publish('db-name', 'payments', 'payments database name');
    publish('db-secret-name', cfg.dbSecretName, 'Secrets Manager name of the payments database credential');
    publish('db-sg-id', sg.securityGroupId, 'security group of the payments postgres cluster (functions get ingress to it)');
  }
}
