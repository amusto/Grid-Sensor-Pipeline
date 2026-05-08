# AWS IoT Core — Cheatsheet

> **Status: STUB** — Phase 4 hasn't shipped yet. Pre-populated with the
> conceptual scaffolding and resource links. Project-anchor sections are
> marked TODO and get filled when `infra/lib/iot-stack.ts`,
> `src/handlers/simulator.ts`, and `scripts/simulate.ts` land.

> **Where this will be used in the project:** `infra/lib/iot-stack.ts`
> (Things, policy, IoT Rules), `src/handlers/simulator.ts` (publishes
> synthetic telemetry), `scripts/simulate.ts` (driver). Decision rationale
> will live in `docs/decisions/phase-04-iot-simulator.md`.

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

## TODO — Project-specific anchors (fill on Phase 4)

When the IoT stack lands, fill in:

- [ ] `infra/lib/iot-stack.ts` — the Thing type, policy, certificate
      resource, and the two IoT Rules.
- [ ] `src/handlers/simulator.ts` — Lambda using
      `@aws-sdk/client-iot-data-plane` to publish synthetic readings.
- [ ] `scripts/simulate.ts` — driver that invokes the simulator N times.
- [ ] Cross-reference: confirm `ThresholdAlertRule` SQL matches
      `src/lib/threshold.ts` exactly (the predicate lives in two places
      — they must stay in sync).

---

## TODO — Tuning knobs (fill on Phase 4)

- [ ] Rule role permissions — minimum-privilege grants from
      `iot.amazonaws.com` to Kinesis and Step Functions.
- [ ] Certificate provisioning method — CDK custom resource for the
      POC; fleet provisioning for production.
- [ ] Topic policy granularity — per-Thing vs per-fleet.
- [ ] Error action on the rule — what happens when the Kinesis put
      fails. Default: drop. Better: error action sends to a separate
      SQS queue.

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

## TODO — CLI cheatsheet (fill during P4 smoke test)

```bash
# Get the data-plane endpoint
aws iot describe-endpoint --endpoint-type iot:Data-ATS

# List Things
aws iot list-things

# List Rules
aws iot list-topic-rules

# Test a rule with a sample payload (in the console — no equivalent CLI)

# Publish a test message via the data plane SDK (Node)
# (see scripts/simulate.ts once it lands)
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
