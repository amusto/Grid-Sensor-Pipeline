# AWS IoT Core — Cheatsheet

> **Status: filled** — Phase 4 implemented. Project anchors below
> reference the actual code.

> **Where this is used in the project:** `infra/lib/iot-stack.ts`
> (IoT Rules + simulator Lambda), `src/handlers/simulator.ts`
> (synthetic telemetry generator), `scripts/simulate.ts` (CLI driver).
> Decision rationale lives in
> [`docs/decisions/phase-04-iot-simulator.md`](../decisions/phase-04-iot-simulator.md).

---

## Mental model

AWS IoT Core is a managed MQTT broker plus a rules engine. Devices speak
MQTT (or HTTP) to the broker, the broker authenticates them via X.509
certificates, and a SQL-like rules engine routes published messages to
downstream AWS services (Kinesis, Step Functions, Lambda, DynamoDB,
SNS…) without a hop through your own code.

Three concerns that justify reaching for IoT Core instead of rolling
your own broker:

1. **Device authentication at scale** — X.509 mutual TLS, with fleet
   provisioning so you don't issue certs by hand.
2. **Device shadows** — a JSON document per device representing
   "desired" and "reported" state. The broker reconciles them when the
   device reconnects.
3. **Declarative routing via Rules** — SQL like `SELECT * FROM
   'sensors/+/telemetry' WHERE value > 126`. No Lambda invocation, no
   cold start, no code to maintain on the path itself.

---

## Core concepts

### Topics
MQTT topics are slash-delimited strings. Devices publish to
`sensors/{sensorId}/telemetry`; subscribers can use wildcards (`+` for
one segment, `#` for multiple). The IoT Rules engine reads from topic
patterns directly.

### Things, certificates, policies
- **Thing** — the digital representation of a device (a name + optional
  attributes).
- **Certificate** — an X.509 cert/key pair attached to a Thing. The
  device presents it on connect; IoT Core verifies it.
- **Policy** — a JSON document attached to a certificate that says what
  the device can do (publish to which topics, subscribe to which, etc.).

### IoT Rules engine
SQL `SELECT` statements that filter and transform incoming MQTT messages,
then route them to AWS targets. Inputs: topic pattern + WHERE clause.
Outputs: Kinesis, SNS, SQS, Lambda, DynamoDB, Step Functions, Firehose,
HTTP, S3, and more.

This project's two rules:

- **AllTelemetryRule** — `SELECT *, topic(2) AS sensorId FROM
  'sensors/+/telemetry'` → Kinesis (partition key = `${sensorId}`).
- **ThresholdAlertRule** — `SELECT * FROM 'sensors/+/telemetry' WHERE
  (readingType = 'frequency' AND (value < 59.5 OR value > 60.5)) OR
  (readingType = 'voltage' AND (value < 114 OR value > 126))` → Step
  Functions `StartExecution`.

The `topic(N)` function extracts the Nth slash-delimited segment of the
publishing topic — that's how `sensorId` ends up in the Kinesis record
even though it wasn't in the original payload.

### Device Shadow
Per-device JSON document with `desired` and `reported` state. Persists
across disconnects. We don't use shadows yet in this project but they're
the standard pattern for "set this device's threshold to X" workflows.

### Device SDKs
- **`aws-iot-device-sdk-v2`** — the production device SDK. Handles
  reconnection, queue-while-offline, MQTT5 features.
- **`@aws-sdk/client-iot-data-plane`** — the *backend* SDK for
  publishing to IoT Core *as if* you were a device, used for testing.
  This project's simulator uses this — no actual MQTT client needed.

---

## Project-specific anchors

- **`infra/lib/iot-stack.ts`** — single stack containing:
  - IoT data endpoint discovery via `AwsCustomResource` calling
    `iot:DescribeEndpoint`.
  - `AllTelemetryRule` — `SELECT *, topic(2) AS sensorId FROM
    'sensors/+/telemetry'` → Kinesis (partition key `${sensorId}`).
  - IoT Rules role with inline `kinesis:PutRecord`/`PutRecords` policy.
  - Simulator Lambda (Node 20, 256 MB, X-Ray active) with
    `iot:Publish` scoped to `sensors/*/telemetry`.
- **`src/handlers/simulator.ts`** — synthetic telemetry generator:
  - Box-Muller Gaussian distribution around realistic nominal values.
  - 5-sensor default pool (`sensor-001` through `sensor-005`).
  - `--breach` flag forces voltage to 110/130 V or frequency to
    59.0/61.0 Hz to trigger the (Phase 5) alert workflow.
  - EMF metrics: `SimulatedEventsPublished`, `SimulatedEventsFailed`,
    `BreachEventsRequested`.
- **`scripts/simulate.ts`** — CLI driver invoking the simulator Lambda
  via `LambdaClient.InvokeCommand`. CLI args: `--count`, `--breach`,
  `--function`, `--region`. Run via `npm run simulate -- --count 50`.
- **Deliberate omissions** (documented in the decision log):
  - No X.509 device certificates — the IAM-authorized Data Plane SDK
    is sufficient for the POC simulator. Production would use Fleet
    Provisioning.
  - No `ThresholdAlertRule` — deferred to Phase 5 alongside the Step
    Functions state machine.
  - No IoT Thing type / Thing object — the simulator publishes
    directly via the data plane and doesn't need device registration.

---

## Tuning knobs in this project

- **Rule role permissions** — `kinesis:PutRecord` + `kinesis:PutRecords`
  on the data stream ARN. Minimum-privilege; assumed by
  `iot.amazonaws.com`. Inline policies in the role constructor (per the
  P3 deploy lessons, to avoid the policy-attachment race).
- **Certificate provisioning** — none. POC uses IAM auth via the data
  plane SDK. Production migration path documented in P4 decision log
  (Fleet Provisioning).
- **Topic policy granularity** — per-Thing wildcard pattern
  (`arn:aws:iot:${region}:${account}:topic/sensors/*/telemetry`). Same
  shape a real device's IoT Thing Policy would use with
  `${iot:Connection.Thing.ThingName}` substitution.
- **Error action on the rule** — none configured (defaults to drop on
  Kinesis put failure). Production should add `errorAction` routing to
  an SQS queue or a separate Firehose for forensics. Deferred until
  Phase 6 (observability).
- **`AwsIotSqlVersion`** — `2016-03-23`. Required for the `topic()`
  function used to extract `sensorId` from the topic path.

---

## Pitfalls (general knowledge — verify during P4)

1. **Test certificates vs production fleet provisioning.** Using
   one-off certificates in CDK custom resources is fine for POC, but
   each device in production needs its own certificate provisioned via
   AWS IoT Fleet Provisioning or Just-In-Time Registration. Don't ship
   the POC pattern to prod.

2. **IoT Rules engine SQL is a subset.** It's not full SQL — no JOINs,
   no subqueries, limited functions. Test rules in the AWS console's
   "Test rule" feature before committing.

3. **Predicate duplication smell.** When the same rule lives in IoT
   Rules SQL *and* in TypeScript (this project: threshold check), the
   two implementations can drift silently. Add a contract test that
   feeds the same fixture matrix to both and asserts agreement.

4. **Topic name vs partition key vs payload field.** Easy to confuse.
   In our setup: the topic is `sensors/{sensorId}/telemetry`,
   `topic(2)` extracts `{sensorId}`, and the rule sets it as the
   Kinesis partition key. The payload itself also contains `sensorId`
   — the rule could use `${sensorId}` from the payload OR `topic(2)`
   from the topic name. We use `topic(2)` because it's the
   authoritative source (the topic the device is authorized to publish
   to).

5. **Per-message cost adds up.** IoT Core is $0.08/M messages plus
   $0.18/M rule evaluations plus $1/M connect-minutes. Negligible at
   POC volume but grows fast in production.

---

## Cost levers, ordered by impact

1. **Message volume.** $0.08 per million messages published. The
   majority of cost at scale.
2. **Rule evaluations.** $0.18 per million rule triggers. Multiple
   rules on the same topic = multiple evaluations.
3. **Connect-minutes.** $1 per million minutes a device is connected.
   Mostly negligible unless you have always-on devices.
4. **Device Shadow operations.** $1.25 per million shadow ops. Only
   matters if you actively use shadows.

For this project's dev volume, total IoT Core cost is rounding-error.

---

## CLI cheatsheet

```bash
# Get the data-plane endpoint (CDK does this automatically via the
# AwsCustomResource in iot-stack.ts; this is for ad-hoc inspection)
aws iot describe-endpoint --endpoint-type iot:Data-ATS

# List Rules
aws iot list-topic-rules

# Inspect the AllTelemetryRule
aws iot get-topic-rule --rule-name gsp_test_all_telemetry  # or your project's name

# Trigger the simulator from the local machine (after deploy)
npm run simulate -- --count 50

# Force breach values to trigger the Phase 5 alert workflow
npm run simulate -- --count 5 --breach

# Watch simulator logs
aws logs tail /aws/lambda/grid-sensor-pipeline-simulator --since 5m

# Verify a record made it through the IoT → Kinesis → DynamoDB path
aws dynamodb scan \
  --table-name grid-sensor-pipeline-readings \
  --limit 5 \
  --query "Items[*].[pk.S, sk.S, value.N, readingType.S]" --output table
```

---

## Learning resources

Ordered by what's most useful first.

### Official docs
- **[AWS IoT Core Developer Guide](https://docs.aws.amazon.com/iot/latest/developerguide/)**
  — read the "Getting Started," "MQTT," and "IoT Rules" sections.
- **[IoT Rules Reference](https://docs.aws.amazon.com/iot/latest/developerguide/iot-rules.html)**
  — the full syntax for the rules engine SQL, including functions like
  `topic()`, `traceid()`, `timestamp()`.
- **[IoT Security Best Practices](https://docs.aws.amazon.com/iot/latest/developerguide/security-best-practices.html)**
  — read this before going to production.

### Hands-on workshops
- **[AWS IoT Core Workshop](https://catalog.workshops.aws/aws-iot-immersionday-workshop/)**
  — official self-paced.
- **[Connecting Devices to AWS IoT Core](https://catalog.workshops.aws/aws-iot-builders/)**
  — covers fleet provisioning patterns.

### Conceptual depth
- **[MQTT specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)**
  — readable for a spec. QoS levels, retained messages, last-will-
  testament are all worth understanding.
- **AWS re:Invent talks** — search YouTube for *"AWS IoT Core Deep
  Dive"* and *"IoT Rules Engine Best Practices"*.

### Comparison context
- IoT Core vs MQTT broker on EKS — when self-hosting makes sense
  (regulatory data residency, ultra-low-latency local broker).
  Pragmatic answer: almost never for a typical SaaS use case.

---

## When to revisit this note

- During Phase 4 implementation — fill the TODO sections from real
  experience.
- Before any conversation about device fleet management or device
  authentication strategy.
- When cost reviews flag IoT Core spend — start with message volume
  and rule evaluation count.
- Before writing fleet provisioning code (production hardening pass).
