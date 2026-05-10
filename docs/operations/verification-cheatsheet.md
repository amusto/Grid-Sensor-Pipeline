# Verification Cheatsheet

> **Status: living doc** — updated as phases ship new resources, Lambdas,
> queues, or metrics. Last updated: Phase 8.2 (LangChain Bedrock client +
> post-destroy verifier).

> **When to use this.** Any time you want to verify *"is the pipeline
> alive?"*, *"did the simulation actually flow through?"*, or *"where in
> the pipeline did data stop?"*. Six tiers, ordered from
> ten-second-sanity-check to full forensics.

---

## Mental model

Verification has two failure modes:

1. **False negative** — system is healthy, but you can't tell. Wastes
   time chasing nothing.
2. **False positive** — system is broken, but the surface you're
   checking happens to look fine. Misleads you to the wrong
   diagnosis.

Defense: **check multiple tiers**, ordered by abstraction level. If
Tier 1 (DynamoDB row count) says data is flowing AND Tier 2 (Lambda
logs) say events are being processed, you have two independent
confirmations. If they disagree, the disagreement *itself* is the
diagnostic signal.

The tiers below are roughly ordered by latency-to-truth (Tier 1 is
fastest, Tier 6 is most thorough). Pick the tier that matches the
question you're asking.

---

## Tier 1 — Ten-second sanity check

The single command answer to "is anything flowing?":

```bash
aws dynamodb scan \
  --table-name grid-sensor-pipeline-readings \
  --select COUNT \
  --query "Count" --output text
```

Returns total row count. Run before and after a simulator invocation;
the delta confirms records flowed end-to-end through IoT → Kinesis →
ESM → processor → DynamoDB.

**Idiomatic verification loop** (pasteable, ~30 seconds):

```bash
BEFORE=$(aws dynamodb scan --table-name grid-sensor-pipeline-readings --select COUNT --query "Count" --output text)
npm run simulate -- --count 20
sleep 5
AFTER=$(aws dynamodb scan --table-name grid-sensor-pipeline-readings --select COUNT --query "Count" --output text)
echo "Before: $BEFORE → After: $AFTER (delta: $((AFTER - BEFORE)))"
```

Expected: delta of `20`. Anything less means records were dropped
somewhere — proceed to Tier 2.

---

## Tier 2 — Per-Lambda logs

The raw evidence. Each Lambda has its own log group; tailing shows
exactly what just happened.

```bash
# Simulator — did events publish to IoT Core?
aws logs tail /aws/lambda/grid-sensor-pipeline-simulator --since 5m

# Processor — did events validate, dedupe, and write to DynamoDB?
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 5m

# Alert handler — did breach events trigger SNS publishes?
aws logs tail /aws/lambda/grid-sensor-pipeline-alert-handler --since 5m

# DLQ inspector — did anything dead-letter?
aws logs tail /aws/lambda/grid-sensor-pipeline-dlq-inspector --since 5m
```

`--follow` on any of these tails in real time. Useful when you simulate
in one terminal and watch logs in another.

### Filter patterns for Powertools-emitted JSON logs

Powertools emits structured JSON. The `--filter-pattern` flag uses
CloudWatch Logs filter syntax (NOT regex). The forms below all work:

```bash
# Substring match in the message field — note the inner double quotes
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 10m \
  --filter-pattern '"Record processed"'

# JSON path filter (most precise)
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 10m \
  --filter-pattern '{ $.message = "Record processed" }'

# Errors only
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 10m \
  --filter-pattern '{ $.level = "ERROR" }'

# Records for one specific sensor
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 10m \
  --filter-pattern '{ $.sensorId = "sensor-001" }'

# Validation failures specifically
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 10m \
  --filter-pattern '{ $.message = "Validation failed" }'
```

**Common mistake:** `--filter-pattern "Record processed"` (no inner
quotes) gets tokenized by the CLI into two terms (`Record` AND
`processed`) and won't match the JSON-quoted `"message":"Record processed"`
value cleanly. Always quote both the outer shell arg AND the inner
search term.

---

## Tier 3 — DynamoDB inspection

The durable output. Confirms data made it all the way through.

```bash
# Latest 10 readings, any sensor, any reading type
aws dynamodb scan \
  --table-name grid-sensor-pipeline-readings \
  --limit 10 \
  --query "Items[*].[pk.S, sk.S, value.N, readingType.S]" \
  --output table

# All readings for a specific sensor (efficient — uses partition key)
aws dynamodb query \
  --table-name grid-sensor-pipeline-readings \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"sensor-001"}}' \
  --query "Items[*].[sk.S, value.N, readingType.S]" \
  --output table

# Count rows for one sensor
aws dynamodb query \
  --table-name grid-sensor-pipeline-readings \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk":{"S":"sensor-001"}}' \
  --select COUNT --query "Count" --output text

# Find recent breaches (voltage below 114V) — uses scan + filter,
# expensive on large tables, fine for POC volume
aws dynamodb scan \
  --table-name grid-sensor-pipeline-readings \
  --filter-expression "readingType = :rt AND #v < :low" \
  --expression-attribute-names '{"#v":"value"}' \
  --expression-attribute-values '{":rt":{"S":"voltage"},":low":{"N":"114"}}' \
  --query "Items[*].[pk.S, sk.S, value.N]" \
  --output table
```

The Powertools idempotency table (`grid-sensor-pipeline-idempotency`)
is also queryable but its records are opaque hashes — rarely useful
for human inspection.

---

## Tier 4 — Kinesis backbone

Confirms data reached the streaming layer (vs being rejected by the
IoT rule).

```bash
# Stream status, shard count, retention
aws kinesis describe-stream-summary \
  --stream-name grid-sensor-pipeline-telemetry \
  --query "StreamDescriptionSummary.[StreamStatus, OpenShardCount, RetentionPeriodHours]" \
  --output table
```

For deeper Kinesis state (consumer iterator age, shard utilization),
the CloudWatch dashboard's `IteratorAge` metric is faster than CLI.

---

## Tier 4.5 — Query API endpoint (Phase 7+)

```bash
URL=$(aws cloudformation describe-stacks \
  --stack-name GridSensorQueryStack \
  --query "Stacks[0].Outputs[?OutputKey=='QueryApiUrl'].OutputValue" \
  --output text)

# Happy path
curl -s "${URL}sensors/sensor-001/readings?limit=5" | jq

# Time-window filter
curl -s "${URL}sensors/sensor-001/readings?from=2026-05-08T00:00:00Z&to=2026-05-09T23:59:59Z&limit=20" | jq

# Validation error path (bad sensorId format)
curl -s -w "\n%{http_code}\n" "${URL}sensors/INVALID-FORMAT/readings"
# Expected: 400 with Zod error details

# Unknown sensor (valid format, no data)
curl -s "${URL}sensors/sensor-999/readings" | jq
# Expected: 200 with {sensorId: "sensor-999", count: 0, items: []}

# Tail query Lambda logs while testing
aws logs tail /aws/lambda/grid-sensor-pipeline-query --since 5m
```

API Gateway access logs are also useful when investigating 4xx/5xx
spikes:

```bash
aws logs tail /aws/apigateway/grid-sensor-pipeline-query --since 15m
```

**Gotcha — `count: 0` after a fresh deploy + simulator run.** The
simulator picks sensor IDs randomly per run. `sensor-001` may not be
in the table even though the pipeline is healthy. To find which
sensor IDs actually have data:

```bash
aws dynamodb scan \
  --table-name grid-sensor-pipeline-readings \
  --region us-east-1 \
  --projection-expression "pk" \
  --query 'Items[*].pk.S' --output text \
  | tr '\t' '\n' | sort -u
```

Then re-curl with one of the listed IDs.

---

## Tier 4.6 — Bedrock + LangChain (Phase 8+)

```bash
# Confirm the alert handler has the BEDROCK_MODEL_ID env var
aws lambda get-function-configuration \
  --function-name grid-sensor-pipeline-alert-handler \
  --region us-east-1 \
  --query 'Environment.Variables.BEDROCK_MODEL_ID' --output text
# Expected: us.anthropic.claude-sonnet-4-6
```

```bash
# Confirm the Bedrock IAM grant on the alert handler's role
ROLE=$(aws lambda get-function-configuration \
  --function-name grid-sensor-pipeline-alert-handler \
  --region us-east-1 \
  --query 'Role' --output text | sed 's|.*role/||')

aws iam list-role-policies --role-name "$ROLE" \
  --query 'PolicyNames' --output text | tr '\t' '\n' | \
  while read -r POLICY; do
    aws iam get-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
      --query 'PolicyDocument.Statement' --output json | \
      jq '.[] | select((.Action | tostring | test("bedrock")))'
  done
# Expected: one statement with bedrock:InvokeModel and a 2-element
# Resource array (inference profile + foundation model). NO bedrock:* wildcard.
```

```bash
# Direct invocation test (current Sonnet on Bedrock requires the
# inference profile ID — bare model ID returns ValidationException)
aws bedrock-runtime invoke-model \
  --region us-east-1 \
  --model-id "us.anthropic.claude-sonnet-4-6" \
  --content-type application/json \
  --accept application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":50,"messages":[{"role":"user","content":"Say hello in one short sentence."}]}' \
  /tmp/bedrock-test.json && cat /tmp/bedrock-test.json | jq .
```

```bash
# Bedrock metrics from the most recent breach (after P8.5 wires
# LangGraph into the alert handler)
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace GridSensorPipeline --metric-name BedrockTokensUsed \
  --dimensions Name=service,Value=grid-sensor-alert-handler \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 --statistics Sum \
  --query 'Datapoints[*].{Time:Timestamp,Tokens:Sum}' --output table

# Same shape works for BedrockInvocations, BedrockLatencyMs, BedrockFallback
```

```bash
# Runaway-cost alarm state (should be OK in steady state)
aws cloudwatch describe-alarms --region us-east-1 \
  --alarm-names BedrockTokens-Runaway \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason}' \
  --output table
```

**Gotcha — `ResourceNotFoundException: This model version has reached
the end of its life`.** Means the model id is now retired. Re-list
active models with `aws bedrock list-foundation-models --region
us-east-1 --by-provider Anthropic --output json | jq` and pick the
current Sonnet tier. Then update both `BEDROCK_MODEL_ID` constant +
IAM ARN in `infra/lib/alert-workflow-stack.ts`.

**Gotcha — `ValidationException: ... isn't supported with on-demand
throughput`.** Means the bare foundation-model ID needs an inference
profile. Run `aws bedrock list-inference-profiles --region us-east-1
--output json | jq` and use the matching `us.*` profile id.

---

## Tier 5 — Step Functions executions (alert workflow)

```bash
ARN=$(aws cloudformation describe-stacks \
  --stack-name GridSensorAlertWorkflowStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlertWorkflowArn'].OutputValue" \
  --output text)

# Recent executions
aws stepfunctions list-executions \
  --state-machine-arn $ARN \
  --max-results 10 \
  --query "executions[*].[name, status, startDate]" --output table

# Drill into one execution's history
EXEC_ARN=<paste-from-list-executions>
aws stepfunctions get-execution-history --execution-arn $EXEC_ARN \
  --max-results 30 \
  --query "events[*].[timestamp, type, taskFailedEventDetails.error]" \
  --output table

# Stop runaway executions (rarely needed, but useful in dev)
aws stepfunctions stop-execution --execution-arn $EXEC_ARN
```

Status values to watch:
- `RUNNING` — usually parked in the 15-minute `WaitForAck` state.
- `SUCCEEDED` — full happy path completed (notification + wait + escalation + resolve).
- `FAILED` — alert handler threw or state machine timed out. Investigate via execution history.
- `TIMED_OUT` — exceeded the workflow's 1-hour timeout. Check for handler errors.

---

## Tier 6 — Visual / browser-based checks

| Surface | URL pattern | Best for |
|---|---|---|
| **CloudWatch Dashboard** | Stack output `DashboardUrl` (`https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=grid-sensor-pipeline-overview`) | At-a-glance system health |
| **X-Ray Service Map** | `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#xray:service-map` (filter to last 30m) | Live data flow with edge-level latency |
| **Step Functions executions** | `https://us-east-1.console.aws.amazon.com/states/home?region=us-east-1#/statemachines` → click your state machine → Executions tab | Workflow execution timeline + per-state inputs/outputs |
| **DynamoDB explorer** | `https://us-east-1.console.aws.amazon.com/dynamodbv2/home?region=us-east-1#table?name=grid-sensor-pipeline-readings` → "Explore items" | Browse stored readings without writing CLI queries |
| **SQS DLQ peek** | `https://us-east-1.console.aws.amazon.com/sqs/v3/home?region=us-east-1#/queues` → click the DLQ → "Send and receive messages" → "Poll for messages" | Inspect dead-lettered records without consuming them |
| **CloudWatch Alarms** | `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:` | Alarm state history |

---

## Pre-deploy state check — orphan detection

Before any `npm run deploy` after a destroy, confirm no orphaned
resources are about to collide with the redeploy. This is automated
in `npm run destroy` (post-destroy-check.sh runs after CDK destroy)
but useful to run standalone if anything seems off:

```bash
npm run destroy:check
```

Or the underlying check directly:

```bash
aws kinesis describe-stream-summary \
  --stream-name grid-sensor-pipeline-telemetry \
  --region us-east-1 \
  --query 'StreamDescriptionSummary.{Name:StreamName,Status:StreamStatus}' 2>&1
# Expected: ResourceNotFoundException = clean state
# Anything else = orphan present, see phase-03-storage-processing.md
# Deploy lesson #4 for the cleanup recipe.
```

If an orphan is detected:

```bash
aws kinesis delete-stream \
  --stream-name grid-sensor-pipeline-telemetry \
  --enforce-consumer-deletion \
  --region us-east-1

# Poll until gone (10-30 seconds typical)
until aws kinesis describe-stream-summary \
  --stream-name grid-sensor-pipeline-telemetry \
  --region us-east-1 2>&1 | grep -q ResourceNotFoundException
do sleep 2; done && echo "✅ stream gone"

npm run deploy
```

This is the documented cure for the recurring CFN-leaks-Kinesis
class of failure (4+ occurrences as of Day 3).

---

## Suggested verification workflow

The minimal loop for "is the pipeline alive?":

```bash
# 1. Quick sanity check — any data flowing recently?
aws dynamodb scan --table-name grid-sensor-pipeline-readings --select COUNT --query "Count" --output text

# 2. Run a small simulation
npm run simulate -- --count 20

# 3. Wait, count again
sleep 5
aws dynamodb scan --table-name grid-sensor-pipeline-readings --select COUNT --query "Count" --output text
```

Delta should be 20. If less:

```bash
# 4. Check processor logs
aws logs tail /aws/lambda/grid-sensor-pipeline-processor --since 2m
```

If processor logs show no invocations: the IoT rule isn't routing.
Check Tier 4 (Kinesis stream metrics) and the IoT rule itself in the
console.

If processor logs show errors: read the structured error message; the
sensorId and sequence number are in every log line for forensic work.

---

## What to watch when something seems off

| Symptom | First thing to check | Likely cause |
|---|---|---|
| `npm run simulate` returns `published: 0` | Simulator Lambda logs | IoT endpoint env var unset, or `iot:Publish` IAM denied |
| Simulator says published but DynamoDB count doesn't grow | Processor Lambda logs | Validation failures (poison input shape), or DynamoDB throttling |
| Records appear with wrong `pk` or `sk` | Processor logs (look for the parsed event) | Topic structure mismatch — `topic(2)` extracting wrong segment |
| Step Functions executions never start despite breach mode | IoT rule SQL filter (in console) | Threshold predicate drift between `lib/threshold.ts` and the SQL |
| Step Functions executions start but never complete | Execution history (Tier 5) | Alert handler erroring; check its logs |
| DLQ depth growing | DLQ inspector logs (Tier 2) | Real failure — read the inspector's structured log for sequence range + reason |
| Dashboard widgets show "No data available" | Verify metric dimensions match emission | Powertools' default `service` dimension; widgets must specify it |
| P99 latency alarm fires unexpectedly | Per-ReadingType processor logs | One reading type is slow (e.g., voltage triggers Step Functions); the others are fine |

---

## Maintenance

This doc is updated *in the same commit* as any phase that introduces:

| Phase change | Update to this doc |
|---|---|
| New Lambda | Add `aws logs tail /aws/lambda/<name>` to Tier 2 |
| New persistent resource (table, queue, stream) | Add inspection command to the appropriate tier |
| New metric | Note the dashboard widget that consumes it |
| New alarm | Add expected steady-state + how to verify it triggers under failure |
| New URL surface (Grafana, custom UI) | Add to Tier 6 |

If you find yourself running an `aws ...` command twice for the same
question, that command belongs in this doc.

---

## Did I actually learn this? — self-test

Without looking back at this cheatsheet, can you:

1. **Name the Tier 1 ten-second check command.** What does its output
   tell you?
2. **Cite the correct CloudWatch Logs filter pattern syntax** for matching
   `"message":"Record processed"` in a Powertools-emitted JSON log.
3. **Explain the difference between `aws dynamodb scan` and `aws dynamodb
   query`** for this project. When is each appropriate?
4. **Name the X-Ray service map URL** (or how to reach it from the
   console). What does it show that the dashboard doesn't?
5. **Walk through the diagnostic logic** when `npm run simulate` reports
   `published: 20` but the DynamoDB count only grows by 15.
6. **Name the Step Functions execution status** for an alert workflow
   currently parked in the 15-minute `WaitForAck` state.

If 2 trips you up, you'll burn 10 minutes the next time you debug a
log query. The CLI tokenization gotcha is the single most common
verification mistake.

If 5 trips you up, reread the "What to watch when something seems off"
table. The diagnostic ladder (simulator → processor → DynamoDB) is
the most useful debugging tool in this repo.
