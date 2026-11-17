/**
 * Per-environment configuration from SSM, same two roots as the wallet and
 * engagement functions:
 *
 *   /<env>/<Name>                    platform-owned (VpcId, PrivateSubnet1/2,
 *                                    ClientSecurityGroupId, MainOtelEndpoint,
 *                                    ApiSecurityDatabaseReadOnlyHost/Port/Name: the
 *                                    api-security DB read for session + feature checks)
 *   /<env>/api-hg-lambda/<n>   app-owned, written by scripts/bootstrap-ssm.sh:
 *       provider-api-url, provider-account-id, provider-webhook-url (optional override),
 *       payments-country, payments-currency, payments-return-url, payments-cancel-url,
 *       wallet-mode (lambda|http), wallet-env (optional: env whose wallet to call), wallet-api-url,
 *       wallet-invoker-policy-arn (optional override), lambda-sg-ids, otel-endpoint,
 *       db-instance-type (RDS class of the payments database, default t4g.micro),
 *       webhook-domain, webhook-hosted-zone-id, webhook-hosted-zone-name
 *       (public webhook on CloudFront, stack <env>-HgWebhookEdge, deployed by deploy:webhook-edge only)
 *     and, written by the database stack:
 *       db-host, db-port, db-name, db-secret-name, db-sg-id, webhook-function-url
 *
 * Secrets never pass through SSM. Two Secrets Manager names are constructed:
 *   <env>/JWTSecret          the platform token secret (already exists)
 *   <env>/ApiSecurityDatabaseReadOnlySecret   read-only credential of api-security (platform-owned)
 *   <env>/HgSecrets    JSON: PROVIDER_API_TOKEN, PROVIDER_WEBHOOK_SECRET, WALLET_API_KEY
 * plus the database credential the database stack generates
 * (`<env>/HgDatabase/postgres`).
 */

import { Construct } from 'constructs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ROUTES, type RouteSpec } from '../../lambdas/_routes';

export interface EnvConfig {
  readonly envName: string;
  readonly vpcId: string;
  readonly privateSubnetIds: readonly string[];
  readonly lambdaSgIds: readonly string[];
  readonly otelEndpoint: string;
  readonly jwtSecretName: string;
  readonly paymentsSecretName: string;
  readonly dbSecretName: string;
  /** Read-only credential of the api-security database (platform-owned secret name). */
  readonly securityDbSecretName: string;
  /** RDS instance class for the payments database, from `db-instance-type` (default t4g.micro). */
  readonly dbInstanceType: string;
  /** Plain (non-secret) env vars, one per SSM parameter. */
  readonly plainEnv: Readonly<Record<string, string>>;
  /** Wallet reached as Lambdas: attach the wallet's invoker policy to the execution roles. */
  readonly walletMode: 'lambda' | 'http';
  /** ARN of the wallet invoker managed policy (deploy-time token), or '' when not published. */
  readonly walletInvokerPolicyArn: string;
  /** True when `provider-webhook-url` is set (an ingress in front of the HTTP runtime); else the webhook Function URL is used. */
  readonly webhookUrlOverridden: boolean;
  /** Custom domain of the public webhook (CloudFront). Empty = functions use the Function URL as is. */
  readonly webhookDomain: string;
  readonly webhookHostedZoneId: string;
  readonly webhookHostedZoneName: string;
  readonly logRetentionDays: number;
  readonly retainLogGroups: boolean;
}

export type FunctionSpec = RouteSpec;
/** Every route, plus the migration function (no HTTP route, invoked by the deploy script). */
export const MIGRATE: FunctionSpec = { slug: 'migrate', method: 'POST', resource: '-', audience: 'any', timeoutSec: 120 };
export const FUNCTIONS: readonly FunctionSpec[] = [...ROUTES, MIGRATE];
export const WEBHOOK_PATH = ROUTES.find((r) => r.slug === 'webhook')!.resource;

export const SSM_ROOT = (envName: string) => `/${envName}/api-hg-lambda`;

export function pascal(name: string): string {
  return name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

const PLAIN_PARAMS: ReadonlyArray<[envVar: string, ssmName: string]> = [
  ['PROVIDER_API_URL', 'provider-api-url'],
  ['PROVIDER_ACCOUNT_ID', 'provider-account-id'],
  ['PROVIDER_WEBHOOK_URL', 'provider-webhook-url'],
  ['PAYMENTS_COUNTRY', 'payments-country'],
  ['PAYMENTS_CURRENCY', 'payments-currency'],
  ['PAYMENTS_RETURN_URL', 'payments-return-url'],
  ['PAYMENTS_CANCEL_URL', 'payments-cancel-url'],
  ['WALLET_MODE', 'wallet-mode'],
  ['WALLET_API_URL', 'wallet-api-url'],
];

export function loadConfig(scope: Construct, envName: string): EnvConfig {
  const platformRoot = `/${envName}`;
  const root = SSM_ROOT(envName);

  const platformSynth = (name: string) => StringParameter.valueFromLookup(scope, `${platformRoot}/${name}`, '-');
  const synth = (name: string) => StringParameter.valueFromLookup(scope, `${root}/${name}`, '-');
  const deploy = (name: string) => StringParameter.valueForStringParameter(scope, `${root}/${name}`);

  const sgIds = synth('lambda-sg-ids');
  const platformSg = platformSynth('ClientSecurityGroupId');
  const otelOverride = synth('otel-endpoint');

  const plainEnv: Record<string, string> = {};
  for (const [envVar, ssmName] of PLAIN_PARAMS) {
    // Synth-time lookup so an unset parameter is simply absent from the
    // function's environment, instead of a CloudFormation failure at deploy.
    if (isPresent(synth(ssmName))) plainEnv[envVar] = deploy(ssmName);
  }
  // Wallet functions are always `<env>-wallet-<route>`; `wallet-env` only points at another environment's wallet.
  const walletEnv = isPresent(synth('wallet-env')) ? synth('wallet-env') : envName;
  plainEnv.WALLET_FUNCTION_PREFIX = `${walletEnv}-wallet-`;
  const walletMode = (isPresent(synth('wallet-mode')) ? synth('wallet-mode') : 'lambda').toLowerCase() === 'http' ? 'http' : 'lambda';

  // The wallet publishes its invoker policy ARN; an override slot exists for an
  // environment where the wallet functions live under another name.
  let walletInvokerPolicyArn = '';
  if (walletMode === 'lambda') {
    if (isPresent(synth('wallet-invoker-policy-arn'))) walletInvokerPolicyArn = deploy('wallet-invoker-policy-arn');
    else if (isPresent(StringParameter.valueFromLookup(scope, `/${envName}/api-wallet-lambda/invoker-policy-arn`, '-'))) {
      walletInvokerPolicyArn = StringParameter.valueForStringParameter(scope, `/${envName}/api-wallet-lambda/invoker-policy-arn`);
    }
  }

  return {
    envName,
    vpcId: platformSynth('VpcId'),
    privateSubnetIds: [platformSynth('PrivateSubnet1'), platformSynth('PrivateSubnet2')].filter(isPresent),
    lambdaSgIds: isPresent(sgIds) ? splitList(sgIds).slice(0, 2) : isPresent(platformSg) ? [platformSg] : [],
    otelEndpoint: isPresent(otelOverride) && otelOverride !== 'none'
      ? otelOverride
      : isPresent(platformSynth('MainOtelEndpoint')) ? StringParameter.valueForStringParameter(scope, `${platformRoot}/MainOtelEndpoint`) : '',
    jwtSecretName: `${envName}/JWTSecret`,
    paymentsSecretName: `${envName}/HgSecrets`,
    dbSecretName: `${envName}/HgDatabase/postgres`,
    securityDbSecretName: `${envName}/ApiSecurityDatabaseReadOnlySecret`,
    dbInstanceType: isPresent(synth('db-instance-type')) ? synth('db-instance-type') : 't4g.micro',
    plainEnv,
    walletMode,
    walletInvokerPolicyArn,
    webhookUrlOverridden: isPresent(synth('provider-webhook-url')),
    webhookDomain: isPresent(synth('webhook-domain')) ? synth('webhook-domain') : '',
    webhookHostedZoneId: isPresent(synth('webhook-hosted-zone-id')) ? synth('webhook-hosted-zone-id') : '',
    webhookHostedZoneName: isPresent(synth('webhook-hosted-zone-name')) ? synth('webhook-hosted-zone-name') : '',
    logRetentionDays: 14,
    retainLogGroups: /^(1|true|yes)$/i.test(process.env.RETAIN_LOG_GROUPS ?? ''),
  };
}

export function isPresent(v: string): boolean {
  return Boolean(v) && v !== '-' && !v.startsWith('dummy-value-for-');
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
