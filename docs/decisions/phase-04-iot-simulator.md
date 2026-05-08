# Phase 4 — IoT Core + Simulator

Status: **pre-flight & implementation**. Replaces the manual `aws kinesis
put-record` smoke test with a real device path: simulator Lambda publishes
to IoT Core via the data plane SDK; IoT Rules engine routes telemetry to
Kinesis; the rest of the pipeline (Phase 3) handles it from there.

For each decision: **concept · alternatives · cost lens · tradeoff
knowingly accepted.**

---

## P4 pre-flight 1 — Skip device certificates entirely for the POC

**Concept.** Use the simplest authentication path that satisfies the
testing scenario; document the production-grade pattern as a deferred
deliverable.

**Decision.** No X.509 device certificates. The simulator Lambda
publishes to IoT Core via the IoT Data Plane SDK
(`@aws-sdk/client-iot-data-plane`), authorized by IAM. No MQTT client,
no cert provisioning, no private-key handling.

**Alternatives.**
- **CDK custom resource that calls `iot:CreateKeysAndCertificate`** —
  works for a one-off cert but stores the private key in CloudFormation
  custom resource state (visible in CFN events / template). Acceptable
  for POC, but it adds non-trivial code (custom resource lifecycle,
  cert attachment, policy attachment) and the simulator wouldn't use
  the cert anyway.
- **AWS IoT Fleet Provisioning** — production-grade. Devices receive
  provisioning credentials at first boot and exchange them for
  permanent X.509 certs. Far too heavy for a single Lambda simulator;
  designed for thousands-to-millions of real devices.

**Why skip.** The simulator is a Lambda, not a real MQTT client. The
IoT Data Plane SDK's `Publish` API uses HTTPS with SigV4 signing — the
function's IAM role is the entire auth surface. Adding a cert would be
deadweight.

**Cost lens.** Direct cost-saving: zero cert storage, zero custom
resource Lambda invocations on every deploy. Indirect: avoiding code
that exists "for completeness" but isn't actually used in any code
path.

**Tradeoff knowingly accepted.** When the project is shown as a
portfolio piece, a reviewer might ask "what about real device auth?"
The answer is documented in `docs/learning/aws-iot-core.md` — for
production, use Fleet Provisioning, not the cert pattern this POC
deliberately omits.

---

## P4 pre-flight 2 — Topic policy granularity: per-Thing wildcards

**Concept.** Even when the auth model is IAM (not cert), the IoT
*authorization* policies should encode the production access pattern so
the same code shape works at scale.

**Decision.** The simulator Lambda's IAM role grants `iot:Publish` only
on the resource ARN pattern
`arn:aws:iot:${region}:${account}:topic/sensors/*/telemetry`. Not `*`,
not all topics — only the pattern the project actually uses.

**Why.** This is the same policy granularity production devices would
get (per-Thing topic wildcards). Keeps the simulator faithful to the
production access model. If we ever migrate the simulator to a real
MQTT client with cert auth, the IoT Thing Policy can mirror this exact
ARN pattern using `${iot:Connection.Thing.ThingName}` substitution.

**Alternatives rejected.**
- Wildcard `iot:*` on `*` resource — easy but teaches the wrong habit.
- Single hardcoded sensor topic — works for one sensor; breaks the
  moment we add a second simulated sensor ID.

**Cost lens.** No direct cost. Indirect: a too-permissive IAM policy in
a portfolio repo is a code-review red flag. Keeping it tight signals
security awareness.

---

## P4 pre-flight 3 — IoT data endpoint discovery via CDK custom resource

**Concept.** Self-bootstrapping infrastructure — don't require manual
shell steps to wire account-specific endpoint values.

**Decision.** Use `AwsCustomResource` to call `iot:DescribeEndpoint` at
deploy time and inject the result as the `IOT_ENDPOINT` environment
variable on the simulator Lambda.

**Alternatives.**
- **Hardcode in CDK context** — requires the user to run
  `aws iot describe-endpoint` once, copy the value into `cdk.json`.
  Easy to forget, breaks for cross-account deploys.
- **Inject via deploy script** — same fragility, more shell.
- **Look up at Lambda cold start** — wastes a `DescribeEndpoint` call
  on every cold start.

**Why custom resource.** Endpoint is account-specific but stable per
account. Resolved once at deploy, baked into the Lambda's env vars,
never re-resolved. The custom resource costs one Lambda invocation per
deploy — negligible.

**Cost lens.** Effectively zero. AWS Custom Resource Lambda invocation
+ one `iot:DescribeEndpoint` API call per deploy.

---

## P4 pre-flight 4 — Defer `ThresholdAlertRule` to Phase 5

**Concept.** Keep phase boundaries aligned with end-to-end deliverables.

**Decision.** Phase 4 deploys ONLY `AllTelemetryRule` (telemetry →
Kinesis). The `ThresholdAlertRule` (out-of-range readings → Step
Functions) is part of Phase 5, where it can be wired alongside the
state machine and tested end-to-end in the same phase.

**Why.** The `ThresholdAlertRule`'s `stepFunctions` action requires the
state machine ARN as input. If Phase 4 deployed it with a placeholder,
Phase 5 would need to update an existing rule — more deploy state to
manage. Cleaner to defer.

**Alternative rejected.** Deploy a placeholder Step Functions state
machine in P4 to satisfy the ARN. Adds throwaway code.

**Cost lens.** No cost difference. Architectural clarity.

---

## P4 pre-flight 5 — Simulator payload distribution: random + `--breach` flag

**Concept.** A simulator that's useful for both happy-path and
deliberate failure-mode testing.

**Decision.** The simulator generates random readings using a Gaussian
(Box-Muller) distribution around realistic nominal values:

| Reading type | Mean | Std dev | Unit |
|---|---|---|---|
| voltage | 120 V | 1.5 V | V |
| current | 15 A | 1 A | A |
| frequency | 60 Hz | 0.1 Hz | Hz |
| power_factor | 0.95 | 0.02 | pf |
| temperature | 25°C | 3°C | degC |

Sensor pool defaults to `sensor-001` … `sensor-005`. The optional
`--breach` flag forces `voltage` to a 110/130 V split or `frequency`
to 59.0/61.0 Hz — guaranteed-breach values for triggering the (Phase
5) alert workflow.

**Why a normal distribution.** Realistic in shape. Produces occasional
edge cases organically, validating that the validator's `value: number`
acceptance is meaningfully tested.

**Why a fixed pool of 5 sensor IDs.** Tests partition-key distribution
across a small Kinesis shard pool. With one shard and five sensor IDs,
records distribute evenly within ordering constraints.

**Cost lens.** No cost difference between normal and uniform. Just
better signal.

---

## P4 pre-flight 6 — Simulator + IoT in one stack

**Concept.** Stack boundary follows lifecycle.

**Decision.** Simulator Lambda lives in `IotStack`, alongside the IoT
Rules engine and the data endpoint discovery.

**Why.** The simulator's only purpose is to feed the IoT path; it
shares the IoT endpoint dependency and is operationally inseparable
from the rules engine. Splitting them across stacks would add CFN
exports/imports for zero benefit.

**Tradeoff accepted.** A change to the simulator code triggers an IoT
stack redeploy. Acceptable — no production-shape consequences (we'd
pull the simulator out of production stacks entirely).

---

## Cross-cutting framing for Phase 4

Three durable patterns this phase encodes:

1. **The production-shape access pattern, even in test code.** The
   simulator's IAM policy uses the same per-Thing wildcard a real
   device would. The code shape works at scale even though the
   implementation doesn't.

2. **Self-bootstrapping infrastructure.** No manual shell steps to wire
   account-specific values; all discovery happens in the deploy itself.

3. **Phase boundaries aligned with end-to-end deliverables.** Defer
   what depends on the next phase rather than build placeholders.
