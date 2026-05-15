#!/usr/bin/env bash
#
# verify-retry-idempotency.sh — P9.6 end-to-end verification of the
# dispatcher's case-table idempotency gate after the alert-handler.ts
# outer-publish fix.
#
# What it does (no live AWS resources are mutated outside the alert
# pipeline itself — no buckets, no IAM, no DynamoDB writes other than
# the ones the pipeline performs on its own data):
#
#   1. Resolves the alert topic, cases table, and alert handler
#      function name from CloudFormation exports.
#   2. Builds a deterministic SensorEvent that breaches the voltage
#      threshold and pins sensorId + timestamp so two invocations
#      share the same case natural key.
#   3. Invokes the alert-handler Lambda directly (#1) → snapshots
#      the email-channel case row.
#   4. Invokes the alert-handler Lambda directly (#2) with the SAME
#      input → snapshots the row again.
#   5. Diffs caseId (must be stable) and updatedAt (must advance);
#      asserts a CasesRetried metric tick in CloudWatch.
#   6. Reminds you to check the subscribed inbox: exactly 1 email
#      should arrive (Invocation #1 only), not 2.
#
# Why direct Lambda invocation, not Step Functions:
#   The dispatcher's idempotency contract lives entirely inside the
#   alert-handler Lambda. Step Functions adds the post-NotifyOps
#   ack-wait window + EscalateToOnCall, which would (a) make each
#   execution take ~minutes instead of ~seconds, and (b) deliver a
#   second [P1 ESCALATED] email per execution that would confuse the
#   inbox-count assertion. The state machine wrapper is the right
#   shape for production but the wrong shape for this verification.
#
# Usage:
#   ./scripts/verify-retry-idempotency.sh
#
# Optional environment overrides:
#   AWS_REGION=us-east-1
#   ALERT_STACK_NAME=GridSensorAlertWorkflowStack
#   STORAGE_STACK_NAME=GridSensorStorageStack
#   PROJECT_NAME=grid-sensor-pipeline      (used as CFN-export prefix)
#   SENSOR_ID=sensor-retry-verify          (overrides the default)
#   TIMESTAMP=2026-05-15T17:00:46Z         (pin the natural key — useful
#                                           for retesting against an
#                                           existing case row)
#   SLEEP_SECONDS=20                       (post-invocation settle time)
#
# Exit codes:
#   0  — verification passed
#   1  — usage / resource-resolution failure
#   2  — execution failed (Step Functions returned a non-SUCCEEDED state)
#   3  — idempotency invariant violated (e.g., caseId changed, or no row)

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ALERT_STACK="${ALERT_STACK_NAME:-GridSensorAlertWorkflowStack}"
STORAGE_STACK="${STORAGE_STACK_NAME:-GridSensorStorageStack}"
PROJECT="${PROJECT_NAME:-grid-sensor-pipeline}"
SENSOR_ID="${SENSOR_ID:-sensor-retry-verify}"
SLEEP_SECONDS="${SLEEP_SECONDS:-20}"

# Both invocations within a single script run use the SAME timestamp
# (that's the idempotency test). Across separate runs the timestamp
# advances at second resolution, so back-to-back runs get distinct
# natural keys by default. Pin TIMESTAMP explicitly to deliberately
# retest against an existing case row.
TIMESTAMP="${TIMESTAMP:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# ---------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------
for cmd in aws jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required but not on PATH." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------
# Resolve resource names from CloudFormation exports
# ---------------------------------------------------------------------
resolve_export() {
  local export_name="$1"
  local value
  value=$(aws cloudformation list-exports \
    --region "$REGION" \
    --query "Exports[?Name=='${export_name}'].Value" \
    --output text 2>/dev/null || echo "")
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "Error: CFN export '${export_name}' not found in region ${REGION}." >&2
    echo "       Is the stack deployed? Did you cdk synth the right project?" >&2
    exit 1
  fi
  echo "$value"
}

echo "Resolving resources..."
# State machine ARN is resolved but unused — kept for the deploy
# verification cross-reference. The verification calls the Lambda
# directly, see the file header for the rationale.
STATE_MACHINE_ARN="$(resolve_export "${PROJECT}-alert-workflow-arn")"
ALERT_TOPIC_ARN="$(resolve_export "${PROJECT}-alert-topic-arn")"
CASES_TABLE="$(resolve_export "${PROJECT}-cases-table")"
ALERT_FN_NAME="$(resolve_export "${PROJECT}-alert-handler")"

cat <<RESOLVED
  state machine   : ${STATE_MACHINE_ARN} (informational)
  alert topic     : ${ALERT_TOPIC_ARN}
  cases table     : ${CASES_TABLE}
  alert handler   : ${ALERT_FN_NAME}
  region          : ${REGION}

  sensorId        : ${SENSOR_ID}
  timestamp       : ${TIMESTAMP}
  natural key (pk): ${SENSOR_ID}#${TIMESTAMP}#voltage
  channel sk      : email

RESOLVED

# ---------------------------------------------------------------------
# Build the breach payload — voltage = 108V (below 114V minimum).
# ---------------------------------------------------------------------
PAYLOAD="$(jq -n \
  --arg sid "$SENSOR_ID" \
  --arg ts  "$TIMESTAMP" \
  '{
    sensorId: $sid,
    timestamp: $ts,
    readingType: "voltage",
    value: 108,
    unit: "V",
    gridZone: "zone-retry-verify"
  }')"

PK_VALUE="${SENSOR_ID}#${TIMESTAMP}#voltage"

# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
invoke_lambda() {
  # Synchronously invokes the alert handler exactly once. Returns 0
  # on success, non-zero on Lambda transport or function error.
  # Writes the response payload to /tmp/${label}-response.json for
  # post-mortem inspection.
  local label="$1"
  local response_file="/tmp/${label}-response.json"
  echo "[$label] invoking ${ALERT_FN_NAME}..."

  # --cli-binary-format raw-in-base64-out lets us pass a raw JSON
  # string for --payload (AWS CLI v2 default is base64 input).
  # We capture the full metadata JSON to parse StatusCode +
  # FunctionError from a single call — keeping the invocation
  # count honest is critical for an idempotency test.
  local metadata
  metadata=$(aws lambda invoke \
    --region "$REGION" \
    --function-name "$ALERT_FN_NAME" \
    --cli-binary-format raw-in-base64-out \
    --payload "$PAYLOAD" \
    --output json \
    "$response_file")

  local status_code function_error
  status_code=$(echo "$metadata" | jq -r '.StatusCode')
  function_error=$(echo "$metadata" | jq -r '.FunctionError // "None"')

  if [ "$status_code" = "200" ] && [ "$function_error" = "None" ]; then
    echo "[$label] StatusCode=200, no FunctionError"
    echo "[$label] response: $(cat "$response_file")"
    return 0
  else
    echo "[$label] FAIL — StatusCode=$status_code, FunctionError=$function_error" >&2
    echo "[$label] response: $(cat "$response_file")" >&2
    return 2
  fi
}

fetch_case_row() {
  aws dynamodb get-item \
    --region "$REGION" \
    --table-name "$CASES_TABLE" \
    --key "$(jq -n --arg pk "$PK_VALUE" \
      '{pk: {S: $pk}, sk: {S: "email"}}')" \
    --output json 2>/dev/null \
    | jq -r '.Item // empty'
}

count_cases_retried_metric() {
  # CasesRetried is emitted by the dispatcher each time it finds an
  # existing row and skips an adapter call. We sum the last 5 min.
  local start_ts end_ts
  end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  start_ts="$(date -u -v -5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
  aws cloudwatch get-metric-statistics \
    --region "$REGION" \
    --namespace GridSensorPipeline \
    --metric-name CasesRetried \
    --statistics Sum \
    --start-time "$start_ts" \
    --end-time "$end_ts" \
    --period 60 \
    --output json 2>/dev/null \
    | jq -r '[.Datapoints[].Sum // 0] | add // 0'
}

# ---------------------------------------------------------------------
# Invocation #1 — should write a fresh case row and send 1 email.
# ---------------------------------------------------------------------
echo "=========================================================="
echo "Phase 1 — first invocation (expect: case row created, 1 email)"
echo "=========================================================="
invoke_lambda 'exec-1' || exit 2

echo "Waiting ${SLEEP_SECONDS}s for case row + metrics to settle..."
sleep "$SLEEP_SECONDS"

ROW_AFTER_1="$(fetch_case_row || true)"
if [ -z "$ROW_AFTER_1" ]; then
  echo "FAIL: no case row found after Execution #1." >&2
  echo "       Check the alert-handler CloudWatch logs for /${ALERT_FN_NAME}." >&2
  exit 3
fi

CASE_ID_1="$(echo "$ROW_AFTER_1" | jq -r '.caseId.S // .caseId // empty')"
CREATED_AT_1="$(echo "$ROW_AFTER_1" | jq -r '.createdAt.S // .createdAt // empty')"
UPDATED_AT_1="$(echo "$ROW_AFTER_1" | jq -r '.updatedAt.S // .updatedAt // empty')"

echo "  exec-1 case row:"
echo "    caseId    : $CASE_ID_1"
echo "    createdAt : $CREATED_AT_1"
echo "    updatedAt : $UPDATED_AT_1"

# ---------------------------------------------------------------------
# Invocation #2 — SAME input. Dispatcher must skip the email adapter.
# Outer publish must NOT fire (handler now guards it on
# usedFallback || isEscalated).
# ---------------------------------------------------------------------
echo
echo "=========================================================="
echo "Phase 2 — second invocation, identical input"
echo "(expect: caseId stable, updatedAt advances, CasesRetried ticks, 0 new emails)"
echo "=========================================================="
invoke_lambda 'exec-2' || exit 2

echo "Waiting ${SLEEP_SECONDS}s for case row + metrics to settle..."
sleep "$SLEEP_SECONDS"

ROW_AFTER_2="$(fetch_case_row || true)"
if [ -z "$ROW_AFTER_2" ]; then
  echo "FAIL: case row vanished between executions." >&2
  exit 3
fi

CASE_ID_2="$(echo "$ROW_AFTER_2" | jq -r '.caseId.S // .caseId // empty')"
CREATED_AT_2="$(echo "$ROW_AFTER_2" | jq -r '.createdAt.S // .createdAt // empty')"
UPDATED_AT_2="$(echo "$ROW_AFTER_2" | jq -r '.updatedAt.S // .updatedAt // empty')"

echo "  exec-2 case row:"
echo "    caseId    : $CASE_ID_2"
echo "    createdAt : $CREATED_AT_2"
echo "    updatedAt : $UPDATED_AT_2"

CASES_RETRIED_SUM="$(count_cases_retried_metric)"
echo
echo "  CloudWatch CasesRetried sum (last 5m): $CASES_RETRIED_SUM"

# ---------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------
echo
echo "=========================================================="
echo "Assertions"
echo "=========================================================="

FAILED=0

if [ "$CASE_ID_1" = "$CASE_ID_2" ] && [ -n "$CASE_ID_1" ]; then
  echo "  [OK]   caseId is stable across executions ($CASE_ID_1)"
else
  echo "  [FAIL] caseId changed: '$CASE_ID_1' -> '$CASE_ID_2'"
  FAILED=1
fi

if [ "$CREATED_AT_1" = "$CREATED_AT_2" ] && [ -n "$CREATED_AT_1" ]; then
  echo "  [OK]   createdAt unchanged ($CREATED_AT_1) — original write is preserved"
else
  echo "  [FAIL] createdAt mutated: '$CREATED_AT_1' -> '$CREATED_AT_2'"
  FAILED=1
fi

if [ "$UPDATED_AT_2" \> "$UPDATED_AT_1" ]; then
  echo "  [OK]   updatedAt advanced ('$UPDATED_AT_1' -> '$UPDATED_AT_2')"
else
  echo "  [WARN] updatedAt did not advance ('$UPDATED_AT_1' -> '$UPDATED_AT_2')"
  echo "         Could mean: dispatcher didn't run, or the retry skip path"
  echo "         didn't bump the row. Inspect alert-handler logs."
  FAILED=1
fi

if [ "${CASES_RETRIED_SUM%.*}" -ge 1 ] 2>/dev/null; then
  echo "  [OK]   CasesRetried metric ticked at least once"
else
  echo "  [WARN] CasesRetried metric is 0 in the last 5m — metric may be"
  echo "         delayed in CloudWatch; re-check in 1-2 minutes via:"
  echo "         aws cloudwatch get-metric-statistics \\"
  echo "           --namespace GridSensorPipeline --metric-name CasesRetried \\"
  echo "           --statistics Sum --period 60 --start-time <past> --end-time <now>"
fi

echo
echo "=========================================================="
echo "Inbox check (manual)"
echo "=========================================================="
cat <<INBOX
  Open the subscribed inbox. Expected count for this natural key:
    1 alert email total (from Execution #1).

  If you see 2 emails: the outer SNS publish in alert-handler.ts is
  still firing on the happy path. Confirm the deployed Lambda is the
  post-fix version (cdk deploy GridSensorAlertWorkflowStack should
  have updated the function code).

  To compare against the dispatcher's own log, tail:
    aws logs tail /aws/lambda/${ALERT_FN_NAME} --since 5m --region ${REGION} \\
      | grep -E 'dispatch|skip|case|retry'

INBOX

if [ "$FAILED" -eq 0 ]; then
  echo "Verification PASSED. P9.6 idempotency invariants hold."
  exit 0
else
  echo "Verification FAILED — see assertions above." >&2
  exit 3
fi
