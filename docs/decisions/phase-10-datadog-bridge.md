# Phase 10 — Datadog bridge

**Status:** ✅ shipped end-to-end on 2026-05-15 (deploy path).

**Date:** 2026-05-15

**Author:** Armando Musto, with Claude pairing on the CDK
implementation, test coverage, and this decision log. Voice pass
pending before public publication.

---

## Goal recap

Get the pipeline's operational telemetry (EMF custom metrics + Lambda
logs) flowing into a production-credible observability platform
alongside CloudWatch, so the project demonstrates the multi-tool
observability pattern that's standard at the kind of teams the
portfolio is targeting (matches the Aireon production stack and
similar shops).

The Phase 10 ROADMAP scoped two paths: a **deploy path** (Datadog
Lambda Extension actually wired in, live metrics visible) or a
**design-doc path** (full integration design captured without a
Datadog account). The original plan leaned design-doc because there
was no Datadog account. The plan changed during Phase 10 work —
opened a Datadog trial, walked the deploy path end-to-end, and
landed P10.1–P10.3 in a single afternoon.

---

## Decision 1 — Deploy path over design-doc path

When the Datadog trial signup was straightforward (~10 minutes for
account + AWS CloudFormation integration), the deploy path became
substantially higher leverage than the design doc would have been.
Three factors:

**Concrete artifact for the portfolio.** A reviewer seeing
"`grid-sensor-pipeline-processor` and `grid-sensor-pipeline-alert-handler`
appearing in Datadog Serverless with EMF metrics in Metrics Explorer"
is materially more credible than the same description in prose. The
Datadog screenshot pairs naturally with the CloudWatch view of the
same metrics for a "two systems, same data" demonstration.

**Trial-window window.** The 14-day Datadog trial covers the
portfolio demo window. Cost beyond the trial isn't a concern because
the resources will be torn down at end of demo (see "Cost cleanup"
in the ROADMAP follow-ups). The trial gives ample runway to capture
the verification artifacts.

**Implementation surface was bounded.** The Lambda Extension is a
managed AWS Lambda layer published by Datadog; wiring it in CDK is
~150 lines including the helper module and tests. Two stack
touchpoints (processor + alert-handler), each a one-line call. The
risk of "ship the deploy path and discover it's a tarball of
incidental complexity" was low.

The design-doc path would have produced a similar document to this
one minus the verification screenshots — useful but strictly weaker
evidence. The deploy path produced this document *plus* the live
verification. Net win.

---

## Decision 2 — Lambda Extension push model over the Forwarder pull model

Datadog offers two architectures for forwarding AWS data:

**Forwarder Lambda (pull-side).** Datadog deploys a "Datadog
Forwarder" Lambda into the account. CloudWatch Log subscription
filters route log groups to that Lambda; the Forwarder parses logs
(including EMF lines) and forwards to Datadog. This is the canonical
recommendation for accounts with many Lambdas already deployed where
adding a layer to each Lambda is impractical.

**Lambda Extension (push-side, layer-based).** Each instrumented
Lambda has the `Datadog-Extension` layer attached. The extension
runs as a sidecar process inside the Lambda runtime sandbox; it
subscribes to the function's log stream, parses EMF lines, and
forwards directly to Datadog. No CloudWatch Log subscription filter
needed.

We chose the Lambda Extension for three reasons:

**Latency.** Extension forwards in batches every ~10 seconds (or at
function shutdown). The Forwarder's CloudWatch subscription filter
adds ~1-3 minutes of latency on top of CloudWatch's own log
ingestion lag. For the "trigger a breach → see the metric move in
Datadog within 30 seconds" portfolio demo, the Extension is the only
viable path.

**Per-function service tagging.** The Extension picks up
`DD_SERVICE`, `DD_ENV`, `DD_VERSION` env vars per-function, so each
Lambda is tagged distinctly in Datadog's Serverless view. The
Forwarder tags everything with whichever service tag is on the
Forwarder Lambda itself, requiring extra log-parsing rules to
re-tag per source Lambda.

**Simpler CDK story.** Attaching a layer + setting env vars + adding
an IAM grant for the secret is purely additive — no subscription
filters to manage, no Forwarder Lambda to keep current. The
`maybeAttachDatadog(scope, fn, service)` helper is a one-line call
at each site.

The Forwarder remains the right answer for accounts with hundreds
of Lambdas where touching each function's deploy is impractical;
not us.

---

## Decision 3 — Why us5 region

Datadog operates in multiple regions (US1 = `datadoghq.com`,
US3 = `us3.datadoghq.com`, US5 = `us5.datadoghq.com`,
EU1 = `datadoghq.eu`, AP1 = `ap1.datadoghq.com`). The signup flow
prompted for a region; selected us5 — newer of the US regions, lower
ingestion latency from us-east-1 (where the AWS resources are
deployed), and matches the regional capacity available to new trial
accounts at signup time.

`DD_SITE=us5.datadoghq.com` is wired as a CDK context default;
override via `-c ddSite=...` if a future re-signup lands on a
different region.

---

## Decision 4 — Lambda Extension layer version pinning

Datadog's Extension layer ARN format is
`arn:aws:lambda:${region}:464622532012:layer:Datadog-Extension:${version}`.
The version increments roughly monthly; ARNs are immutable per
version.

Two valid approaches: pin a specific version (reproducible deploys,
explicit upgrade decisions), or always reference latest (auto-bump,
risk of surprise). We picked **pin a version**, defaulting to v75
with a CDK context override.

Rationale: deploy reproducibility matters for portfolio
demonstration. A reviewer cloning the repo six months later should
get the same Datadog behavior we documented today; chasing latest
would silently change the demo behavior over time. Bumping versions
is an intentional act recorded as a config change with a tested
deploy.

Override pattern:

```bash
cdk deploy --all \
  -c enableDatadog=true \
  -c ddApiKeySecretArn=arn:... \
  -c ddExtensionVersion=78    # bumping from default 75 to 78
```

---

## Decision 5 — API key in Secrets Manager, not env var

The Datadog API key is a credential. Three options for getting it
to the Lambda:

**Plaintext env var.** Set `DD_API_KEY=<value>` in CDK. Trivial,
but the key appears in CloudFormation templates, `cdk diff` output,
CloudWatch Lambda configuration history, and any IAM audit of the
function's environment. Plaintext credentials in IaC are a real
audit finding.

**KMS-encrypted env var.** Encrypt the value, set `DD_KMS_API_KEY`,
let the Extension decrypt on each cold start. Avoids plaintext but
adds KMS key management to the project surface.

**Secrets Manager.** Store the key in Secrets Manager once
(out-of-band via `aws secretsmanager create-secret`), set
`DD_API_KEY_SECRET_ARN=<arn>` in CDK, IAM-grant the Lambda execution
role read access to that specific secret. Datadog's Extension fetches
the secret on cold start and caches per execution environment.

We picked Secrets Manager. Reasoning: matches Datadog's documented
recommended pattern, isolates the credential from any IaC artifact
(the ARN is in the CDK code but the value never is), and the
$0.40/month cost is acceptable. The IAM grant is scoped to the
specific secret ARN — no wildcards — so a future credential
expansion would require an explicit deploy.

The secret is **not managed by CDK** because creating it in CDK
would require the API key value in the deployment input, defeating
the isolation. Instead it's created out-of-band:

```bash
aws secretsmanager create-secret \
  --region us-east-1 \
  --name grid-sensor-pipeline/datadog-api-key \
  --secret-string '<paste-the-key>'
```

This is the same out-of-band-bootstrap pattern as the SNS email
subscription confirmation (Phase 9.2) — some deploy steps are
operational by nature.

---

## Decision 6 — APM tracing deferred

Datadog's Lambda integration supports two depths:

**Metric + log forwarding only** (what we shipped). The Extension
parses EMF lines for custom metrics and forwards CloudWatch Logs.
No application code change required. Sufficient for the "see EMF
metrics in Datadog alongside CloudWatch" acceptance criterion.

**APM distributed tracing.** Adds the `Datadog-Node20-x` (or
matching runtime) tracer layer alongside the Extension. Requires
overriding the Lambda's `handler` property to
`/opt/nodejs/node_modules/datadog-lambda-js/handler.handler` and
setting `DD_LAMBDA_HANDLER=index.handler` so the wrapper finds the
real handler. Produces per-invocation spans covering the function
body, downstream AWS SDK calls, and (with `dd-trace` instrumentation)
internal library calls like the LangGraph node transitions.

We scoped to the Extension-only path. Reasons: (1) APM adds a second
layer and a handler-override CDK change to each instrumented Lambda
— roughly doubles the wiring complexity; (2) the LangGraph node
timings are already logged via Powertools structured logs which
appear in Datadog Logs Search, so the "where did time go during the
alert workflow" question has an answer without APM; (3) the
acceptance criterion was metric visibility, not distributed tracing.

Revival path is documented as a Phase 10 stretch in the ROADMAP and
in this doc — adding tracing is mechanically a single-file CDK
change to `infra/lib/datadog-instrumentation.ts` plus the handler
override pattern. The opt-in helper would gain a new `enableApm`
prop; everything else stays.

---

## Architecture (as-shipped)

```
                ┌──────────────────────────────────────────────┐
                │ AWS account 125667709218 (us-east-1)         │
                │                                              │
   CloudWatch ──┼──► AWS Lambda (processor)                    │
   Logs         │      │                                       │
                │      ├─► Datadog Extension layer (sidecar)   │
                │      │     │ reads stdout EMF lines          │
                │      │     │ batches every ~10s              │
                │      │     ▼                                 │
                │      │   ┌────────────────────────┐          │
                │      │   │ Datadog us5 ingestion  │          │
                │      │   │ — Metrics              │          │
                │      │   │ — Logs                 │          │
                │      │   │ — Serverless view      │          │
                │      │   └────────────────────────┘          │
                │      │     ▲                                 │
                │      │     │ HTTPS, auth via API key         │
                │      │     │ fetched from Secrets Manager    │
                │      │     │ on cold start                   │
                │      │     │                                 │
                │      └─► AWS Lambda (alert-handler) — same  │
                │            layer + same pattern              │
                │                                              │
                │   Pull-side complement:                      │
                │   Datadog AWS integration role polls         │
                │   CloudWatch GetMetricData every 5-10 min    │
                │   for query-api + any other Lambdas not      │
                │   directly instrumented.                     │
                └──────────────────────────────────────────────┘
```

Push (Extension) covers processor + alert-handler with sub-minute
latency and full EMF detail. Pull (AWS integration) covers
everything else in the account at 5-10-minute resolution as a
default. Both paths active simultaneously.

---

## CDK design

A new `infra/lib/datadog-instrumentation.ts` helper centralizes the
wiring so the per-stack call sites stay one line each.

```typescript
// infra/lib/processing-stack.ts
maybeAttachDatadog(this, processor, 'grid-sensor-processor');

// infra/lib/alert-workflow-stack.ts
maybeAttachDatadog(this, alertHandler, 'grid-sensor-alert-handler');
```

`maybeAttachDatadog` reads CDK context to decide whether to wire
anything at all. Default off keeps the deploy path unchanged for
fresh clones, CI, and cost-minimization scenarios. Opt-in via:

```bash
cdk deploy --all \
  -c enableDatadog=true \
  -c ddApiKeySecretArn=arn:aws:secretsmanager:us-east-1:...
```

When opted in, the helper attaches the Extension layer, sets six
env vars (`DD_API_KEY_SECRET_ARN`, `DD_SITE`, `DD_ENV`, `DD_SERVICE`,
`DD_SERVERLESS_LOGS_ENABLED=true`, `DD_TRACE_ENABLED=false`), and
grants Secrets Manager read on the API key secret. The fail-loud
contract is intentional: if `enableDatadog=true` is set but
`ddApiKeySecretArn` is missing, synth throws — silent partial
wiring would surprise the operator at runtime when Datadog never
receives data.

Test coverage: six new assertions per stack —
default-off (no DD env vars present), throws on missing secret ARN,
layer attached when opted in, env vars match, IAM grant scoped to
the secret, context overrides honored.

The helper exports `attachDatadog` (unconditional, takes explicit
props) as well as `maybeAttachDatadog` (context-driven) so tests
can rig the wiring without CDK context plumbing.

---

## Verification

Live verification on 2026-05-15 after the first deploy with
`enableDatadog=true`:

**Push path (Extension):**

1. Ran `npx ts-node scripts/simulate.ts --count 5 --breach` — 5
   events through Kinesis → processor → DynamoDB, with one breach
   triggering the alert workflow.
2. Within 90 seconds, Datadog **Infrastructure → Serverless** showed
   `grid-sensor-pipeline-processor` and `grid-sensor-pipeline-alert-handler`
   as service tiles with invocation count + duration + error rate.
3. **Metrics → Explorer** showed EMF metrics under the
   `gridsensorpipeline.*` namespace (Datadog lowercases + dots-
   separates the CloudWatch `GridSensorPipeline` namespace by default).
   Specifically observed: `gridsensorpipeline.events_processed`,
   `gridsensorpipeline.alerts_notified`, `gridsensorpipeline.bedrock_fallback`.
4. Same metrics simultaneously visible in CloudWatch Metrics under
   `GridSensorPipeline`. **Verification of equivalence:** identical
   data, two systems, no application-code change.

**Pull path (AWS integration):**

5. The CloudFormation stack deployed by Datadog's signup wizard
   created the IAM role and an SQS queue for state tracking. Datadog's
   AWS integration page showed account `125667709218` as connected
   and reporting.
6. `grid-sensor-pipeline-query-api` appeared as a Serverless tile
   with basic Lambda metrics (no Extension means no EMF forwarding,
   so it shows surface telemetry only). Intentional distinction —
   query-api emits no Powertools metrics yet, so deep instrumentation
   would be wasted.

---

## Costs (observed + projected)

**Live + active (POC traffic):**

- Secrets Manager secret: $0.40/month + ~$0.10 in API call charges
  at expected Lambda invocation rates.
- Datadog Extension cold-start overhead: ~50-200ms added to each
  cold start, ~few ms warm. Translates to <$0.50/month additional
  Lambda compute at POC traffic levels.
- CloudFormation/SQS from the Datadog integration: $0 effectively.
- Datadog ingestion (free during 14-day trial; post-trial varies
  by metric + log volume) — see Datadog billing for actuals.

**Idle (deployed but no traffic):**

- Secrets Manager: $0.40/month flat.
- Everything else: $0.

**Torn down:**

- $0. Datadog stops receiving data, AWS resources stop billing.

Total POC impact: under $1/month on the AWS side during the demo
window. Datadog trial covers their side.

---

## Follow-ups deferred to Phase 11

Three issues surfaced during the Phase 10 deploy + verification that
were deliberately not addressed in scope; they're queued against
Phase 11 polish:

**Node.js 20 → Node.js 22 runtime bump.** Datadog's Serverless
"Issues & Insights" view flagged "Deprecated Runtime" against the
Lambdas. AWS Lambda's Node 20 deprecation path: block-update around
May-June 2026, full deprecation following. A `cdk deploy` against
the affected functions will start failing once block-update lands.
Fix is one-line per Lambda definition (`runtime:
lambda.Runtime.NODEJS_22_X` + matching `target: 'node22'` in the
bundling config). Tests should pass unchanged; bundle a quick
re-deploy to verify.

**Duplicate-log cost lever.** Both CloudWatch Logs and the Datadog
Extension are forwarding the same log lines. Datadog charges by
ingestion; we're paying for the same content twice. The Datadog UI
offers a "Turn Off CloudWatch Logs" button that removes the
Forwarder subscription on the relevant log groups (post-trial cost
reduction, not a CDK change). Intentionally left on for the POC —
the `aws logs tail` debug path is too useful to give up during
demo prep, and the dual-write provides defense-in-depth if Datadog
has an outage.

**APM tracing as a Phase 10 stretch.** Adds per-invocation
distributed traces showing the LangGraph node timings, Bedrock
calls, DynamoDB writes — a more impressive demo artifact than just
metrics. Scoped revival: add the `Datadog-Node22-x` tracer layer,
flip `DD_TRACE_ENABLED=true`, override the Lambda handler to the
wrapper path. Roughly one hour of work; explicitly out of P10
acceptance criteria.

---

## Acceptance criteria — met

✅ EMF metrics visible in Datadog (`gridsensorpipeline.*` namespace).
✅ Same metric data visible in both CloudWatch and Datadog without
   application-code change.
✅ Pull-side AWS integration active (Datadog can read CloudWatch).
✅ API key in Secrets Manager, not plaintext.
✅ Default-off opt-in pattern preserves existing deploy paths.
✅ Tests assert the wiring contract on both stacks.

---

## Related decisions

- [Phase 6 — DLQ + observability](./phase-06-dlq-observability.md) —
  defines the EMF metric namespace + Powertools shape the Extension
  forwards.
- [Phase 8 — AI/ML integration](./phase-08-ai-ml-integration.md) —
  the LangGraph + Bedrock layer whose tracing would benefit from
  the APM follow-up.
- [Phase 12 — Demo dashboard](./phase-12-demo-dashboard.md) — the
  pull-side dashboard design; this Phase 10 work is the push-side
  complement.
- [Operations — cost tracking](../operations/cost-tracking.md) —
  the broader cost discipline including teardown checklist for
  Datadog-specific resources.

---

*Live deploy + verification screenshots captured 2026-05-15 evening.
ROADMAP entries: P10.1, P10.2, P10.3 all ✅. Core progress 58/68 → 59/65
after Phase 12 scope change.*
