#!/usr/bin/env bash
# Show which api-hg-lambda SSM slots are filled in for an environment.
#
# Usage: scripts/ssm-status.sh <env>
#
# PENDING means the parameter is missing or still holds the '-' placeholder.
# A PENDING *override* (provider-webhook-url, wallet-invoker-policy-arn,
# lambda-sg-ids, otel-endpoint) is fine — the platform parameter or the
# default behaviour is used instead. A PENDING platform row is not: VpcId and
# the subnets have no fallback and the deploy fails on them. Rows under
# "Written by the deploy" are PENDING until the matching stack has run once.
# ERROR means the lookup itself failed, which is NOT the same as unset.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <env>" >&2
  exit 1
fi

ENV="$1"
ROOT="/${ENV}/api-hg-lambda"
REGION="${AWS_REGION:-us-east-1}"

show() {
  local scope="$1" name="$2" note="${3:-}"
  local value rc

  # stderr is captured rather than discarded, and a failed lookup is reported
  # as ERROR rather than PENDING. Collapsing the two is actively misleading:
  # an expired token would render every row as PENDING, which reads as "you
  # still have to fill these in" when the truth is "this script could not see
  # anything at all".
  value=$(aws ssm get-parameter --region "$REGION" --name "$name" \
            --query 'Parameter.Value' --output text 2>&1) && rc=0 || rc=$?

  if [[ $rc -ne 0 ]]; then
    if [[ "$value" == *ParameterNotFound* ]]; then
      printf '  %-10s %-52s PENDING %s\n' "$scope" "$name" "$note"
    else
      printf '  %-10s %-52s ERROR   %s\n' "$scope" "$name" "${value##*: }"
    fi
    return
  fi

  if [[ -z "$value" || "$value" == "-" || "$value" == "None" ]]; then
    printf '  %-10s %-52s PENDING %s\n' "$scope" "$name" "$note"
  else
    printf '  %-10s %-52s %s\n' "$scope" "$name" "$value"
  fi
}

# Fail once, clearly, rather than printing a screen of ERROR rows — and never
# let unusable credentials masquerade as an unbootstrapped environment.
if ! caller=$(aws sts get-caller-identity --query Account --output text 2>&1); then
  echo "Cannot read SSM: AWS credentials are not usable." >&2
  echo "${caller}" >&2
  echo >&2
  echo "Nothing below would be trustworthy, so nothing is shown." >&2
  exit 1
fi

echo "api-hg-lambda SSM status for ${ENV} in ${REGION} (account ${caller}):"
echo
echo "Platform-owned (must already exist):"
show platform "/${ENV}/VpcId"                 "<- required; no override, no fallback"
show platform "/${ENV}/PrivateSubnet1"        "<- required"
show platform "/${ENV}/PrivateSubnet2"        "<- required"
show platform "/${ENV}/ClientSecurityGroupId" "<- attached to every function unless lambda-sg-ids overrides; both absent = one egress SG per function"
show platform "/${ENV}/MainOtelEndpoint"      "<- unless overridden or disabled below"
echo
echo "Owned by wallet-lambda (read at deploy when wallet-mode = lambda):"
show wallet "/${ENV}/api-wallet-lambda/invoker-policy-arn" "<- PENDING = functions cannot invoke the wallet; deploy wallet-lambda first or set the override below"
echo
echo "App-owned (bootstrap-ssm.sh):"
show app "${ROOT}/provider-api-url"          "<- PENDING = provider calls disabled (NOT_CONFIGURED)"
show app "${ROOT}/provider-account-id"       "<- required for withdrawals (payout source account)"
show app "${ROOT}/provider-webhook-url"      "<- override only; PENDING = the webhook Function URL below"
show app "${ROOT}/payments-country"          "<- PENDING = AR"
show app "${ROOT}/payments-currency"         "<- PENDING = ARS"
show app "${ROOT}/payments-return-url"       "<- where the hosted checkout sends the player back (front-self)"
show app "${ROOT}/payments-cancel-url"       "<- same, on cancel"
show app "${ROOT}/wallet-mode"               "<- lambda|http; PENDING = lambda"
show app "${ROOT}/wallet-function-prefix"    "<- override only; PENDING = ${ENV}-wallet-"
show app "${ROOT}/wallet-api-url"            "<- only when wallet-mode = http"
show app "${ROOT}/wallet-invoker-policy-arn" "<- override only; PENDING = the wallet-lambda row above"
show app "${ROOT}/lambda-sg-ids"             "<- optional override; PENDING = ClientSecurityGroupId (normal)"
show app "${ROOT}/otel-endpoint"             "<- override only; 'none' disables tracing"
echo
echo "Written by the deploy, not by bootstrap:"
show deploy "${ROOT}/player-invoker-policy-arn"   "<- resource-group stack; attach to front-self's task role"
show deploy "${ROOT}/operator-invoker-policy-arn" "<- resource-group stack; attach to the back-office's task role"
show deploy "${ROOT}/db-host"                     "<- database stack"
show deploy "${ROOT}/db-port"                     "<- database stack"
show deploy "${ROOT}/db-name"                     "<- database stack"
show deploy "${ROOT}/db-secret-name"              "<- database stack"
show deploy "${ROOT}/db-sg-id"                    "<- database stack; functions get ingress to it"
show deploy "${ROOT}/webhook-function-url"        "<- webhook stack; register it in the provider dashboard"
echo
echo "Secrets (not shown; existence only):"
# JWTSecret is platform-owned. HgSecrets is created by bootstrap-ssm.sh
# (PROVIDER_API_TOKEN, PROVIDER_WEBHOOK_SECRET, WALLET_API_KEY, WALLET_API_TOKEN,
# DOCUMENT_HASH_KEY). HgDatabase/postgres is generated by the database stack.
for s in "JWTSecret" "HgSecrets" "HgDatabase/postgres"; do
  if aws secretsmanager describe-secret --region "$REGION" \
       --secret-id "${ENV}/${s}" >/dev/null 2>&1; then
    printf '  %-10s %-52s ok\n' secret "${ENV}/${s}"
  else
    printf '  %-10s %-52s PENDING\n' secret "${ENV}/${s}"
  fi
done
echo
echo "JWTSecret must be the SAME value the authorizer uses; every function"
echo "verifies the caller's token with it."
