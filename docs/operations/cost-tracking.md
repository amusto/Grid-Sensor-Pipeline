# Cost Tracking & Budget Alerts

> **Status: living doc** — updated as new resources are introduced
> across phases. Last updated: Phase 7.

> **When to use this.** Daily — quick CLI check before / after dev
> sessions. Weekly — Cost Explorer review of trend lines. Monthly —
> Budget alert review and adjustment.

---

## Mental model

AWS costs accrue silently. Three failure modes worth defending against:

1. **Unintentional always-on resources.** A `cdk destroy` that fails
   silently leaves a Kinesis shard running ($11/month) for weeks.
2. **Volume-based runaway.** A bug that loops a Lambda or floods
   Kinesis can rack up thousands of dollars in days.
3. **Service-specific cost cliffs.** Bedrock token cost, CloudWatch
   Logs ingestion at scale, Step Functions Standard transitions —
   each has its own pricing model that can surprise you.

Defense: **layered cost visibility.** Ad-hoc CLI checks for "what's
the meter reading right now," dashboard surfaces for trend lines, and
automated alerts that wake you up if either of the failure modes
above happens.

This doc is the operational reference for all three layers.

---

## What costs money in this project

Approximate monthly costs when all stacks are deployed and traffic is
at POC levels (a few simulator runs per day):

| Service | Pricing model | POC monthly cost |
|---|---|---|
| **Kinesis Data Stream** (1 shard) | $0.015/hour shard time | **~$11/mo** ← dominant cost |
| Kinesis Firehose | $0.029/GB ingest | <$0.10/mo |
| **DynamoDB** (on-demand, 2 tables + future cases table) | $1.25/M write requests + $0.25/M read | ~$0/mo at POC volume |
| **Lambda** (5 functions) | $0.20/M requests + per-ms×MB | <$0.50/mo |
| **API Gateway REST** (P7) | $3.50/M requests | <$0.10/mo |
| **Step Functions Standard** (P5) | $25/M state transitions | <$0.10/mo |
| **CloudWatch Logs** | $0.50/GB ingested | $1-3/mo (varies with log volume) |
| **CloudWatch Dashboards** | First 3 free, $3 each after | $0/mo (we have 1) |
| **CloudWatch Alarms** | $0.10/alarm/month | $0.30/mo (3 alarms) |
| **SNS** | $0.50/M publishes | <$0.01/mo |
| **S3** (archive bucket + lifecycle) | $0.023/GB Standard, less for IA/Glacier | <$0.50/mo |
| **X-Ray** (tracing) | $5/M traces recorded | <$0.10/mo |
| **SES** (P9 email, when added) | $0.10/1k emails | <$0.01/mo |
| **Bedrock** (P8, when added) | per token, model-specific | $1-5/mo at POC alert volume |
| **VPC / data egress** | varies | $0/mo (no VPC; Lambda egress free) |

**Typical total when deployed: $13-20/month.** Mostly Kinesis shard
time. **When destroyed: $0/month** — no shard hours, no idle DynamoDB
cost, no per-second meters.

**Cost cliff to watch.** A simulator stuck in a loop publishing
millions of events would push DynamoDB on-demand costs into double
digits per hour. Lambda concurrency caps at 1000 (account default)
provide a soft ceiling but Kinesis can ingest far faster than that
into the DLQ.

---

## One-time setup (do these first, before the rest of this doc works)

### Activate Cost Explorer

```bash
# Cost Explorer must be enabled before any cost APIs work.
# This is a one-time, free, account-wide setting.
aws ce list-cost-allocation-tags 2>&1 | head -3
```

If that errors with *"Cost Explorer is not enabled,"* go to **AWS
Billing Console → Cost Explorer → Launch Cost Explorer.** Click the
button. Done.

### Activate the `project` cost-allocation tag

CDK already tags every resource in this project with `project: grid-sensor-pipeline`
(set in `infra/bin/app.ts`). But the tag must be *activated* in the
billing console before Cost Explorer can filter on it.

**One-time step:** AWS Billing Console → Cost Allocation Tags →
**User-Defined Cost Allocation Tags** → find `project` → check it →
Activate.

Once activated, costs from new resources show up filtered by tag
within ~24 hours.

---

## Tier 1 — Ad-hoc CLI cost queries

The fastest way to answer *"what am I paying right now?"*

### Month-to-date total

```bash
START=$(date -u +%Y-%m-01)
END=$(date -u +%Y-%m-%d)
aws ce get-cost-and-usage \
  --time-period Start=$START,End=$END \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --query 'ResultsByTime[0].Total.UnblendedCost.Amount' --output text
```

Returns the running month total. Run before and after a dev session
to measure session cost.

### Yesterday's spend by service

```bash
YESTERDAY=$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)
TODAY=$(date -u +%Y-%m-%d)
aws ce get-cost-and-usage \
  --time-period Start=$YESTERDAY,End=$TODAY \
  --granularity DAILY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query "ResultsByTime[0].Groups[].[Keys[0], Metrics.UnblendedCost.Amount]" \
  --output table
```

Returns yesterday's cost broken down by service. Useful for
*"the day I forgot to destroy, what did it actually cost?"*

### Project-only spend (uses the `project` tag)

```bash
START=$(date -u +%Y-%m-01)
END=$(date -u +%Y-%m-%d)
aws ce get-cost-and-usage \
  --time-period Start=$START,End=$END \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{"Tags":{"Key":"project","Values":["grid-sensor-pipeline"]}}' \
  --query 'ResultsByTime[0].Total.UnblendedCost.Amount' --output text
```

Filters out costs from other AWS work in the same account. Requires
the `project` tag to be activated (see one-time setup above).

### Forecast: end-of-month projection

```bash
START=$(date -u +%Y-%m-%d)
# Calculate first of next month
END=$(date -u -v+1m +%Y-%m-01 2>/dev/null || date -u -d 'next month' +%Y-%m-01 | sed 's/.*/&/')
aws ce get-cost-forecast \
  --time-period Start=$START,End=$END \
  --metric UNBLENDED_COST \
  --granularity MONTHLY \
  --query 'Total.Amount' --output text
```

Returns the forecast cost for the rest of the current month based on
recent burn rate. *"At my current pace, I'll finish the month at $X."*

### Per-stack cost breakdown (if you tag stacks differently)

This project tags everything as `project: grid-sensor-pipeline`. If
you ever want per-stack cost, add a `stack` tag in
`infra/bin/app.ts`:

```ts
cdk.Tags.of(storage).add('stack', 'storage');
cdk.Tags.of(kinesis).add('stack', 'kinesis');
// etc. — then re-deploy
```

After re-deploy and tag activation:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$START,End=$END \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=TAG,Key=stack \
  --output table
```

---

## Tier 2 — Console surfaces

For trend lines, anomaly detection visualizations, and ad-hoc
exploration that's awkward via CLI.

| Surface | URL | Best for |
|---|---|---|
| **Cost Explorer** | `https://console.aws.amazon.com/cost-management/home#/cost-explorer` | Trend lines, group-by views, custom date ranges |
| **Billing Dashboard** | `https://console.aws.amazon.com/billing/home#/` | Month-to-date summary, forecasted total, top 5 services |
| **AWS Budgets** | `https://console.aws.amazon.com/billing/home#/budgets` | View / edit configured budgets and recent alarms |
| **Cost Anomaly Detection** | `https://console.aws.amazon.com/cost-management/home#/anomaly-detection` | ML-detected anomalies; free; alerts on unusual spikes |
| **Cost & Usage Reports** | `https://console.aws.amazon.com/billing/home#/reports` | Full forensic CUR exported to S3 (heavy; only set up if needed) |

Bookmark Cost Explorer specifically. Daily 30-second glance: *"Is the
trend line where I expect it?"*

---

## Tier 3 — Automated budget alerts

Set up once; never wonder again whether the meter is running away.

### Recommended budget setup

For this POC, two budgets cover both concerns (slow drift and sudden
spikes):

| Budget | Threshold | Alert at | Purpose |
|---|---|---|---|
| **`grid-sensor-monthly`** | $25/month | 50%, 80%, 100% actual + 100% forecasted | Catches both organic drift (forgot to destroy) and sudden spikes |
| **`grid-sensor-daily`** | $5/day | 100% | Catches a runaway loop within a single day; noise threshold for normal use is well under $1/day |

### Setup via console (fastest, ~5 minutes)

1. Console → **Billing → Budgets → Create budget**
2. Choose **Customize (advanced)**
3. **Cost budget**, **Monthly** period
4. Budget amount: **$25**
5. **Budget scope: Filter to specific AWS cost dimensions** → Tag
   → `project = grid-sensor-pipeline`
6. **Configure alerts:**
   - Threshold 1: 50% actual → email to your address
   - Threshold 2: 80% actual → email to your address
   - Threshold 3: 100% actual → email to your address
   - Threshold 4: 100% forecasted → email to your address
7. Save.
8. Repeat for the daily budget — same setup, $5/day instead of
   $25/month.

You'll get an email confirmation, then alerts fire automatically.

### Setup via CDK (IaC-managed, optional)

If you want budgets in source control rather than console-managed,
create `infra/lib/budgets-stack.ts`:

```ts
import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';

export interface BudgetsStackProps extends cdk.StackProps {
  projectName: string;
  alertEmail: string;
}

export class BudgetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BudgetsStackProps) {
    super(scope, id, props);

    const projectTagFilter = {
      tagKeyValue: [`user:project$${props.projectName}`],
    };

    const subscriber: budgets.CfnBudget.SubscriberProperty = {
      address: props.alertEmail,
      subscriptionType: 'EMAIL',
    };

    const thresholds = [
      { type: 'ACTUAL', percent: 50 },
      { type: 'ACTUAL', percent: 80 },
      { type: 'ACTUAL', percent: 100 },
      { type: 'FORECASTED', percent: 100 },
    ];

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${props.projectName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 25, unit: 'USD' },
        costFilters: projectTagFilter,
      },
      notificationsWithSubscribers: thresholds.map((t) => ({
        notification: {
          notificationType: t.type,
          comparisonOperator: 'GREATER_THAN',
          threshold: t.percent,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [subscriber],
      })),
    });

    new budgets.CfnBudget(this, 'DailyBudget', {
      budget: {
        budgetName: `${props.projectName}-daily`,
        budgetType: 'COST',
        timeUnit: 'DAILY',
        budgetLimit: { amount: 5, unit: 'USD' },
        costFilters: projectTagFilter,
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [subscriber],
        },
      ],
    });
  }
}
```

**Critical: don't include `BudgetsStack` in the default `cdk deploy
--all`.** Budgets should *outlive* `npm run destroy` so alerts keep
firing while the rest of the infrastructure is torn down. Two
options:

- **Option A** — deploy once via flag: `cdk deploy GridSensorBudgetsStack -c deployBudgets=true`. The stack only deploys when the flag is set. `npm run destroy` skips it.
- **Option B** — separate CDK app in `infra/budgets-app/`. Fully
  isolated lifecycle. More setup, more isolation.

Option A is the lower-effort starting point. Add this to
`infra/bin/app.ts` only if you adopt the IaC approach:

```ts
if (app.node.tryGetContext('deployBudgets') === 'true') {
  new BudgetsStack(app, 'GridSensorBudgetsStack', {
    env,
    projectName,
    alertEmail: app.node.tryGetContext('alertEmail') ??
      'armando.musto+aws-budget@gmail.com',
  });
}
```

---

## Tier 4 — Cost Anomaly Detection (optional, free, ML-driven)

AWS Cost Anomaly Detection auto-analyzes your spending patterns and
alerts on statistically anomalous spikes. Free service. Recommended
for the "I might miss something during dev sessions" case.

### Setup

1. Console → **Billing → Cost Anomaly Detection** → Create monitor
2. Monitor type: **AWS services** (or "Cost category" if you have
   one). Choose AWS services for broad coverage.
3. Alert subscription: email at threshold $5 (anomalies above this
   amount trigger).
4. Save.

Alerts fire when a service starts spending unusually for *your*
account's pattern — e.g., DynamoDB suddenly costing 3× the recent
baseline. Catches the runaway-loop scenario faster than a fixed
budget would.

---

## Suggested cost-monitoring workflow

| Cadence | Action | Time cost |
|---|---|---|
| **Before each dev session** | `BEFORE=$(month-to-date-cost-cli)` — capture baseline | 5s |
| **After each dev session** | `AFTER=$(month-to-date-cost-cli); echo $((AFTER - BEFORE))` — verify session cost is reasonable; run `npm run destroy` if not already | 10s |
| **End of every weekday** | Glance at Cost Explorer browser tab — does today's bar match expectation? | 30s |
| **End of every week** | Cost Explorer trend line — is the slope rising? Why? | 2-3 min |
| **End of every month** | Cost & Usage Report walkthrough; budget threshold review (raise / lower if needed) | 10 min |
| **Whenever a budget alert fires** | Investigate within 24 hours; either confirm expected (e.g., a deployed-week scenario) or root-cause | varies |

The 10-second before/after delta is the most useful daily habit. It
makes the cost of dev sessions visible in real time, not as a
month-end surprise.

---

## What to watch when something seems off

| Symptom | First thing to check | Likely cause |
|---|---|---|
| Month-to-date cost rising faster than expected | Cost Explorer per-service breakdown for the last 7 days | Kinesis shard always-on (forgot `cdk destroy`); CloudWatch Logs ingestion spike |
| One service dominating costs unexpectedly | Cost Explorer filter on that service, group by usage type | A misconfigured resource (e.g., wrong DynamoDB capacity mode) or a runaway loop |
| Budget alarm fires but you didn't change anything | Cost Anomaly Detection report (if enabled); CloudWatch Logs for unusual Lambda activity | A poison-pill record causing repeated retries; a forgotten test loop |
| Costs higher than projected on destroy | `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE` to verify destroy actually completed; orphaned Kinesis stream pattern from P3 | Failed destroy left stateful resources behind |
| `cdk destroy` says success but cost meter keeps running | Check for orphaned resources outside CloudFormation: Kinesis streams, S3 buckets, DynamoDB tables, EBS snapshots | The Phase 3 deploy-lessons orphan pattern |

---

## Maintenance

This doc is updated when:

| Trigger | Update |
|---|---|
| New phase introduces a new AWS service | Add row to "What costs money" table; note typical $/month |
| Pricing changes (rare but happens) | Update the per-service amounts |
| Budget threshold changes | Update Tier 3 amounts |
| New cost anomaly category appears | Add to "What to watch" table |

If you hit a cost surprise, **add the surprise to the "What to watch"
table.** That's how this doc stays useful — it grows in proportion to
your forensic experience.

---

## Did I actually learn this? — self-test

Without looking back at this doc, can you:

1. **Name the dominant monthly cost** when this project is deployed.
   Why does that single service drive most of the bill?
2. **Cite the one-time setup steps** required before any of the CLI
   commands work. What's the consequence of skipping them?
3. **Explain why budgets should outlive `cdk destroy`.** What's the
   architectural pattern (separate CDK app, conditional flag,
   console-managed)?
4. **Describe the difference between** AWS Budgets, Cost Anomaly
   Detection, and Cost Explorer. When would you reach for each?
5. **State the 10-second daily habit** that catches most dev-session
   cost surprises.
6. **Name the symptom-to-cause mapping** for "month-to-date cost
   rising faster than expected." What's the first place to look?

If 3 trips you up, reread Tier 3. The "budgets outlive destroy"
pattern is the single most important architectural call in cost
management — get it wrong and you'll silently miss alerts during
exactly the windows where you're most likely to forget.
