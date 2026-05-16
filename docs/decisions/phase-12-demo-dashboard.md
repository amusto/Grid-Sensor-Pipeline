# Phase 12 — Live demo dashboard (design doc, documentation-only path)

**Status:** documentation-only — design captured, implementation
deferred. See "Why documented, not built" below.

**Date:** 2026-05-15

**Author:** Armando Musto, with Claude pairing on draft + structure.
Voice pass pending before public publication.

---

## Goal recap

A single shareable URL that gives a portfolio reviewer the "oh, neat"
moment in under 30 seconds — live operational metrics flowing in real
time, with a button to trigger more events on demand. CloudWatch first
for the quick win; Grafana to demonstrate the data-source flexibility
familiar from production work at Aireon.

The original Phase 12 plan scoped six build sub-phases (CloudWatch
dashboard CDK stack, public sharing toggle, Grafana decision log,
Grafana dashboard build, simulator trigger button, portfolio
integration). This document folds all six into a single design
artifact that explains what would be built, why, and how, so a
reviewer can assess the design judgment without the project needing
to keep the implementation live and accruing AWS cost.

## Why documented, not built

Three reasons, in order of weight:

**1. Marginal portfolio value.** The Phase 10 Datadog Serverless view
and the existing CloudWatch metric console already provide the "see
the metrics flowing" artifact. Phase 6 shipped the observability stack;
EMF metrics are visible in the `GridSensorPipeline` CloudWatch
namespace and tagged into Datadog. A Phase 12 CDK dashboard would be
*nicer* — single page, single URL, public share-link — but it doesn't
materially change what a reviewer can assess. The product judgment a
custom dashboard demonstrates is the *choice of widgets and layout*,
which this design doc captures in writing with equal clarity and zero
runtime cost.

**2. Cost permanence vs. demo permanence.** A live dashboard URL only
works while the AWS resources are deployed. Tearing down for cost
reasons (the standard practice at the end of every dev session — see
[`docs/operations/cost-tracking.md`](../operations/cost-tracking.md))
makes the URL break. A static design doc — with widget screenshots
captured during the Phase 10 verification run — remains a permanent
portfolio artifact regardless of whether the AWS account is currently
deployed. This is the same logic that drove the Phase 10 design-doc
fallback path before we elected to ship the deploy path during the
Datadog free trial window.

**3. Time-boxing.** The build path was estimated at 10–14 hours
across two focused sessions. The documentation path is ~2 hours of
writing in a single sitting. Time saved is invested into Phase 11
polish (README revision in voice, decision-log index) — the work
that more directly affects whether a reviewer keeps reading or
closes the tab.

The implementation surface is sketched below in enough detail that a
future "actually build it" session is mechanically straightforward —
one new CDK stack file, one new Lambda, one new static HTML page,
plus Grafana deployment steps. Nothing in this design depends on
choices that would be expensive to reverse.

---

## Sub-design 1 — CloudWatch dashboard via CDK

### What would ship

A new `infra/lib/dashboard-stack.ts` CDK stack instantiating a single
`cloudwatch.Dashboard` construct with five widgets in a two-column
layout. The stack reads existing metric / log group references from
the other stacks (passed as props from `infra/bin/app.ts`) — no new
runtime resources, only a dashboard view onto existing data.

### Widget inventory

**Widget 1 — Per-sensor latest reading (LogQueryWidget).**

Logs Insights query against the processor's structured logs:

```
fields @timestamp, sensorId, readingType, value, unit
| filter sensorId like /sensor-/
| stats latest(value) as currentValue,
        max(@timestamp) as lastSeen
        by sensorId, readingType
| sort sensorId asc
```

Renders as a sortable table showing one row per (sensor, readingType)
pair. Fragile widget — depends on Powertools-structured log lines
keeping the `sensorId` and `readingType` field names stable. Worth a
ten-line `pickStructuredFieldsForDashboard()` helper in
`src/lib/logger.ts` so a refactor of those field names is a one-place
update rather than a silent dashboard break.

**Widget 2 — Pipeline throughput (GraphWidget).**

Metric: `GridSensorPipeline / EventsProcessed`, statistic `Sum`,
period 1 minute, dimensioned by `ReadingType`.

Renders as a stacked area chart with one band per reading type
(voltage, frequency, current, temperature, harmonic). Visualizes the
pipeline's ability to ingest at scale and provides a real-time signal
when the simulator pushes events.

**Widget 3 — Processing latency (GraphWidget).**

Metric: `GridSensorPipeline / ProcessingLatencyMs`, three line series:
`p50`, `p95`, `p99`. Period 1 minute. No dimension breakdown — overall
pipeline latency.

Renders as three superimposed lines, p99 on top, p50 on bottom. The
gap between p50 and p99 visualizes tail latency; flat lines signal
healthy steady-state, spikes signal cold starts or downstream
contention.

**Widget 4 — DLQ depth (SingleValueWidget + GraphWidget side-by-side).**

`ApproximateNumberOfMessagesVisible` on the processor DLQ. The
SingleValueWidget displays the current count as a big number (the
"alarm at a glance" indicator — should always be 0 in steady state).
The GraphWidget shows the same metric over time so a reviewer can
see whether the DLQ has ever accumulated and how quickly it was
drained.

**Widget 5 — Alert workflow executions (GraphWidget).**

Step Functions execution metrics: `ExecutionsStarted`,
`ExecutionsSucceeded`, `ExecutionsFailed`, dimensioned by
`StateMachineArn` (only one state machine in this project, but the
dimension keeps the widget portable). Period 1 minute, statistic
`Sum`.

Renders alert-workflow load over time — every breach the simulator
triggers shows up as a tick. Useful for the "what happened during
this 5-minute demo window" review pattern.

### Layout

```
+---------------------------------------------------------------+
|  Widget 1 — Per-sensor latest readings (full width, ~30% h)   |
+---------------------------------------+-----------------------+
|  Widget 2 — Throughput by reading     |  Widget 3 — Latency   |
|  type (stacked area, 50% / 50%)       |  p50/p95/p99          |
+---------------+----------------------+------------------------+
|  Widget 4a    |  Widget 4b — DLQ     |  Widget 5 — Alert       |
|  DLQ count    |  depth over time     |  workflow executions    |
|  (single val) |  (graph)             |  (graph)                |
+---------------+----------------------+-------------------------+
```

CDK shape:

```typescript
new cloudwatch.Dashboard(this, 'GridSensorDashboard', {
  dashboardName: `${props.projectName}-demo`,
  defaultInterval: cdk.Duration.hours(1),
  widgets: [
    [latestReadingsLogWidget],
    [throughputWidget, latencyWidget],
    [dlqCountSingle, dlqDepthGraph, alertExecutionsWidget],
  ],
});
```

The rows-of-arrays form gives the two-column layout natively. Each
widget is ~10–15 lines of CDK (metric ref + statistic + dimension +
period + title).

### Defaults

- Time range: 1 hour rolling, 1-minute granularity. Long enough to
  see demo data accumulate, short enough that idle periods don't
  drown the signal.
- Auto-refresh: 30 seconds. Lets a reviewer click "Send events" in
  the trigger button and watch the chart move without manual refresh.
- No alarms on the dashboard widgets directly — alarming is Phase 6's
  job; this dashboard is observation-only.

### Test coverage sketch

`infra/__tests__/dashboard-stack.test.ts` would assert: dashboard
resource exists with expected name, body parses as JSON, widget count
matches expected layout, each metric widget references the correct
namespace + metric name, the Logs Insights widget contains the
expected `fields | filter | stats` shape. Five to seven assertions —
the dashboard is more visual than structural so heavy testing isn't
worth the maintenance cost.

### Risks + mitigations

- **Logs Insights widget fragility.** As noted, the per-sensor widget
  depends on log field stability. Mitigation: route field names through
  a single helper in `src/lib/logger.ts`.
- **Step Functions metrics missing if not enabled.** Step Functions
  emits the `ExecutionsStarted` etc. metrics by default; no enablement
  needed. Worth verifying live the first time the widget renders.
- **Visual layout needs tuning.** CDK construct positions are
  approximate; one post-deploy adjustment pass is almost always
  needed. Budget 30 minutes for visual fixes after the first deploy.

---

## Sub-design 2 — Public sharing

The dashboard is private by default. AWS supports public sharing
(introduced in late 2023; expanded coverage through 2024–2025) where a
dashboard exposes a public URL anyone can view without an AWS account.
The shared view is read-only and shows the same data as the owner sees.

### Steps

1. After `cdk deploy`, open the AWS Console → CloudWatch → Dashboards
   → `grid-sensor-pipeline-demo`.
2. Click **Actions → Share dashboard**.
3. Choose "Anyone with a link" sharing mode. AWS issues a permanent
   URL of the form `https://cloudwatch.amazonaws.com/dashboard.html?dashboard=...&context=...`
4. Copy the URL, paste into the project README under the demo section.
5. Document the share token in `_private/demo-share-url.md` (not in
   git history) for revocation purposes if needed.

### Why this isn't in CDK

AWS CloudFormation does not yet manage the public-sharing state of
a CloudWatch dashboard — it's a console / CLI-only action. CDK
deploys the dashboard; the share toggle is a post-deploy operational
step. This is the same pattern as the SNS subscription confirmation
clicks documented in Phase 9.

### Cost

Public sharing is free. The shared dashboard adds no per-query cost
distinct from owner views. Public dashboards do count against the
"first three dashboards free per region" allowance — this is dashboard
#2 (Phase 6 was the first), so still within the free tier.

### Risks + mitigations

- **Accidental exposure of sensitive metrics.** This dashboard shows
  pipeline telemetry only — sensor IDs, throughput, latency. No PII,
  no business secrets. The risk is bounded.
- **Demo URL going stale when AWS resources are torn down.** The
  shared URL returns a "dashboard not found" view after teardown.
  Acceptable for portfolio purposes; the screenshot artifact captured
  during a live deploy run is the permanent record.

---

## Sub-design 3 — Grafana three-option comparison

Three deployment options were evaluated. The shortlisted choice is
**Local Grafana via Docker, screenshots embedded in the portfolio
README** for the reasons in the decision matrix below.

### Option A — Amazon Managed Grafana

Fully managed Grafana service. AWS handles provisioning, scaling,
patching, SSO via AWS IAM Identity Center.

- **Setup time:** 30–60 minutes (workspace creation + SSO config +
  CloudWatch data source).
- **Ongoing cost:** ~$9 per active user per month. Inactive users free.
- **Pros:** No infrastructure to manage. SSO works out of the box.
  Production-credible — matches enterprise patterns.
- **Cons:** Cost is per-user; even one active reviewer triggers
  billing. SSO setup adds an interview-day step ("let me grant you
  access"). Workspace persists between sessions even when not in use.
- **Best fit:** Multi-reviewer interactive demo where the cost is
  worth the polished experience.

### Option B — Self-hosted Grafana on t3.micro EC2

Plain EC2 instance running Grafana OSS via Docker or system package.

- **Setup time:** 2–3 hours (EC2 + IAM role + security group +
  Grafana provisioning + reverse proxy with TLS).
- **Ongoing cost:** ~$7.50/month for t3.micro (or free under EC2 free
  tier for the first 12 months) + ~$0.50/month for storage. Plus a
  small NAT/data egress charge per visit.
- **Pros:** Full control. Always-on URL works for any visitor without
  SSO. Familiar pattern from Aireon.
- **Cons:** Ongoing cost regardless of usage. Patching is on me.
  Single instance = single point of failure. Real risk of the box
  expiring or the disk filling and the demo URL silently breaking.
- **Best fit:** Production patterns demo with a fixed cost ceiling
  the candidate is comfortable owning.

### Option C — Local Grafana via Docker, screenshots embedded

Run Grafana locally via `docker-compose up`, point at CloudWatch as
the data source using temporary AWS credentials, capture screenshots
of the dashboards, embed the screenshots in the project README. No
always-on Grafana surface.

- **Setup time:** 60–90 minutes (docker-compose file + CloudWatch
  data source config + dashboard JSON build + screenshot capture).
- **Ongoing cost:** $0 — Grafana runs locally only when needed.
- **Pros:** Zero ongoing cost. Screenshots are permanent — they
  survive any AWS teardown, account change, or trial expiry.
  Reproducible: docker-compose file is committed to the repo so a
  reviewer can run it locally with their own AWS credentials if they
  want to verify the live data.
- **Cons:** Not interactive in the portfolio — reviewer sees a
  screenshot, not a live dashboard they can click around in.
- **Best fit:** Portfolio-permanence-first projects where cost
  permanence matters more than interactive surface.

### Decision

**Option C — Local Grafana via Docker + screenshots.**

Three factors drove the call: (1) zero ongoing cost matches the
project's broader cost-tracking discipline (see
[`docs/operations/cost-tracking.md`](../operations/cost-tracking.md));
(2) portfolio permanence is load-bearing — the project is interview
prep and may be reviewed months after any specific AWS resources
exist; (3) the deliverable is a *design* artifact for product
judgment, not a live interactive dashboard — screenshots communicate
the same widget choices and layout decisions without the operational
overhead. Option A or B would be revisited if a specific interview
audience explicitly asks for live interactive access during a
scheduled demo window.

This same logic is why Phase 12 broadly was scoped to documentation-
only — the design + screenshots demonstrate the engineering judgment
without the cost or maintenance surface.

---

## Sub-design 4 — Grafana dashboard build (local Docker path)

### Stack

```yaml
# docker-compose.yml
version: '3.8'
services:
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: "true"   # local-only; safe
      GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
    volumes:
      - ./grafana-data:/var/lib/grafana
      - ./grafana-provisioning:/etc/grafana/provisioning
```

### CloudWatch data source

Grafana reads CloudWatch metrics directly. Authentication via local
AWS credentials (whatever `~/.aws/credentials` or `AWS_PROFILE` is
set to when starting docker-compose). The AWS account read by
Grafana is the same account where the Grid Sensor stacks are
deployed.

Required IAM permissions (added to the running user's profile, not
codified in IaC because this is a local-only dev tool):
- `cloudwatch:ListMetrics`
- `cloudwatch:GetMetricData`
- `cloudwatch:GetMetricStatistics`
- `logs:DescribeLogGroups`, `logs:StartQuery`, `logs:GetQueryResults`
  (if reproducing the per-sensor LogQueryWidget)

### Panel inventory

Mirrors the CloudWatch widgets one-for-one initially. Where Grafana
adds value over CloudWatch is in the *richer* per-sensor /
per-zone breakdowns that CloudWatch's grid layout doesn't display
cleanly:

- **Heatmap panel** — sensor activity by hour of day. Same data as
  the latest-readings table but visualized as a time-of-day heatmap.
- **Per-zone aggregation** — group readings by `gridZone`, show
  active sensors per zone. Useful for the "zonal grid topology"
  narrative if discussing the broader product context.
- **Threshold overlays** — voltage min/max bands rendered as
  horizontal reference lines on the per-reading-type panels, so
  breaches are visually obvious.

These three Grafana-only panels are what make the side-by-side
"CloudWatch vs Grafana" comparison interesting; without them the
Grafana dashboard would just be a clone.

### Athena over S3 cold archive (optional)

If Phase 6's S3 cold-storage archive ships in a future revision, an
Athena data source could be added to Grafana for historical panels
beyond CloudWatch's 15-month retention. Out of current Phase 6 scope;
mentioned here for design completeness.

### Screenshot capture

After building the dashboard locally:

1. Open dashboard at `http://localhost:3000/d/grid-sensor-pipeline`.
2. Use Grafana's built-in "Share → Snapshot → Local Snapshot" or
   browser screenshot.
3. Save as `docs/portfolio/grafana-dashboard-{date}.png`.
4. Embed in the project README's "Live demo" section.

### Provisioning artifacts (committed to repo)

- `tools/grafana/docker-compose.yml` (~30 lines)
- `tools/grafana/provisioning/datasources/cloudwatch.yaml` (~15 lines)
- `tools/grafana/dashboards/grid-sensor.json` (~200 lines of
  Grafana dashboard JSON)
- `tools/grafana/README.md` walking through `docker-compose up`,
  AWS credentials setup, dashboard navigation

A reviewer can clone the repo, set their AWS credentials, run
`docker-compose up`, and see the same dashboard with their own data
flowing — turning "screenshots in a portfolio" into "fully reproducible
demo" without any always-on cost.

---

## Sub-design 5 — Simulator trigger button

The goal is letting a reviewer push new data into the pipeline
without an AWS account or CLI — so a single page loads, has a "Send
events" button, and the dashboard updates within ~10 seconds.

### Architecture

```
[Reviewer's browser]
        |
        | HTTPS GET / POST
        v
[Lambda Function URL]  --invokes-->  [simulate Lambda]  ---->  [IoT Core]
        ^
        |
        +-- Static HTML served by the same Lambda on GET /
```

A single Lambda handles two routes:
- `GET /` returns a small static HTML page with a button + form
- `POST /trigger` invokes the simulator logic and returns the event
  count + a `dashboard URL` link

### Lambda

`src/handlers/trigger-button.ts` — wraps the existing `scripts/simulate.ts`
logic (currently a local-only Node script). The simulator code already
generates random `SensorEvent` payloads and publishes to IoT Core via
the AWS SDK. The Lambda reuses the same generator + same publish
function; the difference is the invocation source.

Function URL config:
- Auth: `NONE` (public). Acceptable for a portfolio demo.
- Throttle: `reservedConcurrentExecutions: 2` plus CloudWatch alarm
  on `Invocations > 100/hour` to alert on accidental traffic spikes.
- CORS: `AllowedOrigins: ['*']`, `AllowedMethods: ['GET', 'POST']`,
  `AllowedHeaders: ['*']`. Permissive for a public demo.
- Timeout: 10 seconds (enough to publish 50 events to IoT Core).

### Static HTML

Served inline from the Lambda handler — single file, no S3 bucket
needed, no CloudFront, no extra surface.

```html
<!doctype html>
<html>
  <head><title>Grid Sensor demo trigger</title></head>
  <body>
    <h1>Grid Sensor Pipeline — send a burst</h1>
    <form id="f">
      <label>Event count: <input name="count" type="number"
        min="1" max="50" value="10"/></label>
      <label><input type="checkbox" name="breach"/> Force a threshold breach</label>
      <button type="submit">Send events</button>
    </form>
    <div id="result"></div>
    <p>
      <a href="DASHBOARD_URL_HERE" target="_blank">Open dashboard</a>
      (refreshes every 30s)
    </p>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        const r = await fetch('?trigger=1', {
          method: 'POST',
          body: JSON.stringify({
            count: Number(data.get('count')),
            breach: data.get('breach') === 'on',
          }),
        });
        const json = await r.json();
        document.getElementById('result').innerText =
          `Sent ${json.eventCount} events. Open the dashboard.`;
      });
    </script>
  </body>
</html>
```

Total: ~50 lines of HTML + JS, embedded as a string in the Lambda
handler.

### CDK shape

A new `src/handlers/trigger-button.ts` and a small construct in
`infra/lib/trigger-button-stack.ts` (or appended to an existing
stack). The IAM grant lets the trigger Lambda invoke the simulator
publish path on IoT Core.

### Security

Public Function URLs without auth are a calculated risk. Mitigations:
- Hard cap on event count per call (`max="50"` in the form, validated
  server-side as well).
- Concurrency limit on the Lambda (2 reserved executions).
- CloudWatch alarm on invocation rate >100/hour to detect abuse.
- IoT Core's MQTT message rate limits add a final natural cap.
- No PII or sensitive data flows through this path.

Acceptable for portfolio demo traffic; would not ship as-is for any
production-traffic system.

---

## Sub-design 6 — Portfolio integration

### Project README section

Add a "Live demo" section between the architecture overview and the
quickstart:

```markdown
## Live demo

**Interactive dashboard:** https://cloudwatch.amazonaws.com/dashboard.html?...
**Trigger a burst of events:** https://abc123.lambda-url.us-east-1.on.aws/

The dashboard refreshes every 30 seconds. Click "Send events" in the
trigger UI, then return to the dashboard tab — within 10 seconds the
throughput and latency charts show the new traffic. Force a threshold
breach via the checkbox to fire the alert workflow.

![Dashboard screenshot](./docs/portfolio/cloudwatch-dashboard.png)
![Grafana dashboard](./docs/portfolio/grafana-dashboard.png)

The Grafana dashboard is captured as a screenshot because the Grafana
deployment is local Docker only — see
[`tools/grafana/README.md`](tools/grafana/README.md) for the
reproducible setup. Live AWS resources are torn down between dev
sessions for cost reasons; the screenshots remain the permanent
artifact.
```

### amusto.github.io portfolio card

Add a "Live demo" link to the Grid Sensor card (hero position 1).
Both the dashboard and trigger URLs.

### 30-second screen recording GIF (optional but recommended)

Capture a screen recording of: dashboard idle → click "Send events" →
dashboard line moves → click "Force breach" → alert workflow
execution appears in the alert-executions widget.

Convert to GIF, embed in the project README as the first visual. The
GIF works after AWS teardown — the portfolio artifact is permanent
even when the live URL isn't.

Tools: macOS built-in screen recording → ffmpeg conversion
(`ffmpeg -i recording.mov -vf "fps=10,scale=800:-1" -loop 0 demo.gif`).
Target file size <2MB so the README loads quickly.

---

## Acceptance criteria for the documentation-only deliverable

This design doc is acceptable when:

- ✅ A reviewer reading this doc can describe what would be built
  without ambiguity (widget inventory, CDK shape, deployment options).
- ✅ The Grafana three-option comparison is decisive — recommendation
  is clear and the reasoning is auditable.
- ✅ The simulator trigger button architecture is concrete enough that
  the future "actually build it" session is mechanical, not exploratory.
- ✅ Cost permanence trade-offs are explicit.
- ✅ The doc cross-links to existing decision logs and operations docs.

The original Phase 12 build acceptance criteria (live URL with new
data visible within 10 seconds) remain in the deprecated build plan
section of `ROADMAP.md` for any future revival.

---

## Related decisions

- [Phase 6 — DLQ + observability](./phase-06-dlq-observability.md) —
  defines the EMF metric namespace + structured log shape this
  dashboard consumes.
- [Phase 10 — Datadog bridge](./phase-10-datadog-bridge.md) — the
  push-side metric path; this dashboard is the pull-side equivalent.
- [Operations — cost tracking](../operations/cost-tracking.md) —
  the broader cost discipline that drove the documentation-only call.

---

## Open questions for future revival

- Does AWS CloudWatch finally support managing public sharing via
  CloudFormation? Re-check before any build session — would let
  P12.2 move from operational to declarative.
- Has Grafana Cloud's free tier evolved enough to be a viable
  fourth option in the three-way comparison? Currently 10k series /
  50GB logs / 14-day retention free; worth a re-evaluation at build
  time.
- Lambda Function URL idle costs — still $0 at idle as of mid-2026,
  but verify before opting back into a public always-on URL.

---

*This document is the active Phase 12 deliverable. The original
six-build-sub-phase plan is preserved in `ROADMAP.md` under
"Phase 12 — Original (deprecated) build plan (kept for reference)".*
