# Grid Sensor Pipeline — Observability Interview Talking-Track

*First-person narrative for interviews. Each section is something I can speak to for 60–90 seconds, with the "why" behind the decision and a tie-back to the production CloudWatch work I did at Cisco. Skim the **TL;DR** line if I only have 30 seconds.*

---

## The one-paragraph frame

**TL;DR:** On the Grid Sensor Pipeline I treated observability as an architectural concern, not a bolt-on. Every Lambda emits structured JSON logs, custom business metrics as CloudWatch EMF, and X-Ray traces, all through AWS Lambda Powertools so the instrumentation is consistent across handlers and I'm not hand-rolling correlation IDs. The signals that matter — P99 processing latency, DLQ depth, and Step Functions alert-workflow failures — drive CloudWatch alarms. The same discipline I'd applied at Cisco on long-running ECS containers, just translated to a serverless, event-driven shape.

When I talk about this I lead with the *problem*: this is grid telemetry. If a voltage breach gets silently dropped because a record failed validation and nobody noticed, that's a safety-relevant miss. So the bar wasn't "do I have logs" — it was "can I prove, from telemetry alone, that every reading was either stored or quarantined, and can I see latency degrading before it becomes an outage."

---

## Why Lambda Powertools instead of rolling my own

**TL;DR:** Powertools gave me one consistent instrumentation layer — Logger, Tracer, Metrics — so every handler logs, traces, and meters the same way, and the metrics path is EMF so I never block the request to push a metric.

I instantiate three singletons per service — `Logger`, `Tracer`, and `Metrics` — and wrap the handler with `tracer.captureLambdaHandler` and `logger.injectLambdaContext`. That decorator pattern is the part I'd emphasize: `injectLambdaContext` automatically stamps every log line with the cold-start flag, function name, request ID, and any keys I append, so correlation is free. I'm not threading a request ID through twelve function calls by hand, which is exactly the kind of thing that rots the moment someone's in a hurry.

The honest reason I reached for Powertools is that I'd already felt the pain of inconsistent instrumentation on a team. When every service logs in its own shape, your queries don't compose and your dashboards are bespoke per service. Powertools enforces a house style for free. That consistency is worth more than any single feature in it.

---

## Structured logging

**TL;DR:** JSON logs, never string concatenation, with `sensorId` and `readingType` as first-class fields so I can pivot in CloudWatch Logs Insights instead of grepping.

Every log line is structured: `logger.info('Processing', { sensorId, readingType })`, never an interpolated string. The reason is queryability. In CloudWatch Logs Insights I can write `filter readingType = "voltage" | stats count() by bin(5m)` and get an answer in seconds, because those are real fields, not substrings I have to regex out. On the error path I log the Kinesis sequence number alongside the error — `logger.error('Record failed', { error, seq })` — so when something lands in the DLQ I can trace the exact record back through the stream.

This is the single habit that most changes day-two operability, and it's the one I learned the hard way at Cisco. We had services logging free-text strings, and every incident turned into a grep-and-pray exercise across container logs. Once we moved to structured JSON and shipped it to CloudWatch Logs, "what's the error rate for tenant X in the last hour" went from a 20-minute archaeology session to a one-line query. I carried that lesson straight into this project: structure first, because you can't retrofit queryability onto logs you've already thrown away.

---

## EMF metrics — the part most people get wrong

**TL;DR:** I emit custom business metrics as Embedded Metric Format, which means the metric is just a specially-shaped log line. CloudWatch extracts it asynchronously, so I get custom metrics with zero added request latency and no `PutMetricData` API call in the hot path.

This is the piece I most like talking about because it shows I understand the *cost* of observability, not just the mechanics. The naive way to emit a custom metric is to call the CloudWatch `PutMetricData` API synchronously inside your handler. That's a network round-trip on your critical path, it's subject to API throttling, and under load your metrics emission becomes a source of latency and failure in the very system you're trying to measure.

EMF inverts that. Powertools' `Metrics` buffers metrics during the invocation and `publishStoredMetrics()` flushes them as a single structured log line to stdout. CloudWatch's EMF ingestion parses that line out-of-band and materializes real CloudWatch metrics from it. So the metric costs me a `console.log`, not an API call. The actual metrics I emit are the ones that tell a business story: `EventsProcessed`, `ProcessingLatencyMs`, `ValidationErrors`, and `PartialBatchFailures`, dimensioned by `ReadingType`. That last dimension matters — it lets me see whether voltage readings are failing at a different rate than frequency readings, which would point at a specific sensor class or schema drift.

The contrast with Cisco is the interesting bit. On ECS, the equivalent move was Container Insights plus the CloudWatch agent and the embedded `StatsD`/EMF sidecar pattern — a long-lived process scraping and aggregating. On a container that runs for days, an aggregating agent makes sense. On Lambda, where the process is ephemeral and you're billed by the millisecond, EMF-via-stdout is the right shape because there's nothing to keep alive and nothing to block on. Same goal — custom metrics without taxing the workload — but the deployment model forces a different mechanism. Being able to articulate *why* the mechanism differs between ECS and Lambda is usually where the conversation gets good.

---

## X-Ray distributed tracing

**TL;DR:** `tracer.captureLambdaHandler` auto-instruments the handler and AWS SDK calls; I add manual subsegments around the meaningful work so a trace shows where the time actually went across IoT → Kinesis → Lambda → DynamoDB.

X-Ray is what makes this *distributed* observability rather than per-Lambda observability. A single sensor reading crosses IoT Core, Kinesis, the processor Lambda, and DynamoDB — and when a threshold is breached, it also fans into Step Functions, Bedrock, and SNS. Tracing stitches that into one timeline. The Tracer auto-captures the handler and patches the AWS SDK clients, so my DynamoDB `putReading` shows up as its own segment with timing, automatically. Where I want sharper resolution I open a manual subsegment — `tracer.getSegment()?.addNewSubsegment('processRecord')` — and close it in a `finally`, so the trace separates "my processing logic" from "the DynamoDB write." When P99 latency creeps up, that distinction tells me immediately whether it's my code or a downstream dependency, which is the difference between a five-minute fix and an afternoon.

I also turned on `tracingEnabled: true` on the Step Functions state machine, so the alert escalation workflow produces its own X-Ray trace. For safety-critical alerting I want to *see* the path through Notify → Wait → Choice → Escalate, not infer it from logs.

The Cisco parallel: on ECS we ran the X-Ray daemon as a sidecar container and the app talked to it over UDP on localhost. Same tracing model, but again the deployment differs — sidecar daemon for a persistent container, built-in Powertools tracer for the function. The mental model of segments and subsegments transfers one-to-one; only the plumbing changes.

---

## Alarms — choosing the right signals

**TL;DR:** I alarm on P99 processing latency, DLQ depth, and Step Functions failures — symptom-level signals a human should act on — not on raw CPU or invocation counts that don't map to user impact.

The dashboard tracks DLQ depth, P99 latency, and Step Functions failures, and those three are the alarms. I'm deliberate about alarming on *symptoms the operator cares about* rather than vanity metrics. Three I'd defend in a design review:

**P99 latency, not average.** Averages hide the tail, and the tail is where the pain lives — the slow 1% is often a specific shard, a hot partition, or a dependency degrading. I alarm on the 99th percentile of `ProcessingLatencyMs` because that's the number that predicts an outage; the mean will look fine right up until it doesn't. This is a direct lesson from Cisco, where we shifted our SLO alarms from average to P99/P99.9 after a string of incidents that never tripped an average-based alarm.

**DLQ depth > 0 is a real alarm.** A record reaching the dead-letter queue means a sensor reading failed processing after all retries. For grid telemetry that's not noise — it's a reading I can't account for. Any sustained DLQ depth pages, because the whole "every reading is stored or quarantined, provably" guarantee runs through that queue.

**Step Functions execution failures.** The alert workflow is the safety path. If *it* fails — a breach fired but the escalation broke — that's the worst case, an alert about a failed alert. Standard Workflow retains 90 days of execution history, so when one fails I can open the exact execution and see which state threw and with what input.

The framing I land on: good alarms map to "a human should do something now." CPU at 80% doesn't meet that bar on its own; a reading I can't account for does.

---

## How it all fits — and the Datadog bridge

**TL;DR:** Powertools writes EMF and structured logs to CloudWatch natively; in production the Datadog Lambda Extension parses the same stdout and forwards it, so I get a second pane of glass with zero application code changes.

The thing I'm proudest of architecturally is that the application code knows nothing about *where* the telemetry goes. It writes structured logs and EMF to stdout. CloudWatch ingests that natively. And the Datadog Lambda Extension, added purely as a CDK layer plus environment variables, parses the same stream and forwards it — so my structured log fields (`sensorId`, `readingType`, `service`) become Datadog tags automatically. Switching or adding an observability backend is an infrastructure decision, not a code change. That separation — instrument once, route in infrastructure — is the principle I'd want any team I'm on to hold.

---

## Anticipated follow-up questions (and my honest answers)

**"EMF vs. PutMetricData — when would you actually call PutMetricData?"** When I need the metric to exist *outside* a compute invocation — say a scheduled reconciliation job emitting a single gauge — or when I'm not in a context that ships stdout to CloudWatch Logs. Inside a Lambda on the hot path, EMF wins every time.

**"What's the cost of all this tracing?"** X-Ray samples — it's not 100% of requests by default — so the overhead and cost are bounded. EMF metrics cost effectively a log line. The real cost is CloudWatch Logs ingestion volume, which I manage with sensible log levels and retention, not by instrumenting less.

**"Did you build the alarms before or after the failures?"** Before — that's the point of doing it as an architecture exercise. But I'll be honest that the *thresholds* are first guesses; in a real deployment you tune P99 and DLQ-depth thresholds against observed baselines over the first couple of weeks, or you page yourself at 3am over nothing.

**"What would you add next?"** Composite alarms, so a single downstream blip doesn't fire three separate pages, and anomaly-detection bands on latency instead of static thresholds. And an SLO/error-budget framing on top, which is where the Cisco experience would push me — alarms are tactical, error budgets are how you decide what to actually prioritize.

---

## The 30-second version, if that's all I get

I built observability into the Grid Sensor Pipeline as a first-class concern using AWS Lambda Powertools: structured JSON logging for queryability, EMF metrics so custom business metrics cost a log line instead of a blocking API call, and X-Ray tracing to follow a single reading across IoT Core, Kinesis, Lambda, and DynamoDB. The alarms watch the signals that map to real impact — P99 latency, DLQ depth, and alert-workflow failures — not vanity metrics. It's the same CloudWatch discipline I ran on ECS containers at Cisco, re-shaped for a serverless, event-driven system where the deployment model rewards out-of-band, stdout-based telemetry over long-lived agents.
