# Cloud-Native Telemetry & Event Processing Architecture

This project demonstrates a scalable cloud-native telemetry and event processing platform designed for Green Energy infrastructure and large-scale IT Data-Center environments.

The platform ingests real-time telemetry data from distributed IoT sensors, evaluates operational thresholds and anomaly conditions, and orchestrates event-driven workflows for alerting, remediation, operational visibility, and downstream automation.

The implementation was intentionally designed around an AWS-native architecture to align with modern enterprise cloud patterns commonly used across energy infrastructure, smart-grid modernization initiatives, and hyperscale operational environments.

---

# Core Platform Capabilities

* Real-time IoT telemetry ingestion
* Event-driven processing pipelines
* Threshold breach detection
* Distributed workflow orchestration
* Serverless operational automation
* Time-series telemetry processing
* Scalable cloud-native architecture
* AI-ready streaming foundations
* Operational observability and monitoring
* Infrastructure automation and extensibility

---

# Cloud-Native Architecture Alignment

| Capability                  | AWS (Implemented Architecture) | Microsoft Azure                     | Google Cloud Platform (GCP)    | Kubernetes / Open Source           |
| --------------------------- | ------------------------------ | ----------------------------------- | ------------------------------ | ---------------------------------- |
| IoT Device Ingestion        | AWS IoT Core                   | Azure IoT Hub                       | MQTT Broker + Pub/Sub          | EMQX / Mosquitto                   |
| MQTT Support                | Native MQTT Broker             | Native MQTT Broker                  | External MQTT Required         | Native MQTT Brokers                |
| Real-Time Streaming         | Kinesis Data Streams           | Azure Event Hubs                    | Google Pub/Sub                 | Apache Kafka                       |
| Event Processing            | Lambda + Step Functions        | Azure Functions + Durable Functions | Cloud Functions + Workflows    | Temporal + Kafka Streams           |
| Workflow Orchestration      | AWS Step Functions             | Durable Functions                   | Google Workflows               | Temporal / Camunda                 |
| Threshold Breach Processing | Lambda Rules Engine            | Azure Stream Analytics              | Dataflow                       | Apache Flink                       |
| Time-Series Storage         | Timestream                     | Azure Data Explorer                 | BigQuery                       | InfluxDB / TimescaleDB             |
| Long-Term Object Storage    | S3                             | Blob Storage                        | Cloud Storage                  | MinIO / Ceph                       |
| Monitoring & Metrics        | CloudWatch                     | Azure Monitor                       | Cloud Operations Suite         | Prometheus + Grafana               |
| Alerting                    | SNS / EventBridge              | Azure Alerts                        | Cloud Monitoring Alerts        | Alertmanager                       |
| AI / ML Integration         | SageMaker                      | Azure ML                            | Vertex AI                      | Kubeflow / Ollama                  |
| Infrastructure as Code      | CloudFormation / Terraform     | Bicep / Terraform                   | Deployment Manager / Terraform | Helm / ArgoCD / Terraform          |
| Container Platform          | ECS / EKS                      | AKS                                 | GKE                            | Kubernetes                         |
| Event Bus                   | EventBridge                    | Event Grid                          | Pub/Sub                        | Kafka / NATS                       |
| Serverless Compute          | Lambda                         | Azure Functions                     | Cloud Functions                | Knative                            |
| Edge Computing              | Greengrass                     | Azure IoT Edge                      | Anthos Edge                    | K3s / KubeEdge                     |
| Vendor Lock-In Risk         | Medium-High                    | Medium-High                         | Medium                         | Low                                |
| Hybrid / On-Prem Support    | Moderate                       | Strong                              | Moderate                       | Excellent                          |
| Best Fit                    | Enterprise Cloud-Native IoT    | Industrial & Microsoft Ecosystems   | AI / Analytics Heavy Workloads | Portable Multi-Cloud Architectures |

---

# Architectural Direction

The platform follows an event-driven and serverless-first design model intended to support:

* High-volume telemetry ingestion
* Distributed operational monitoring
* Infrastructure automation
* Real-time anomaly detection
* Streaming data workflows
* Intelligent operational decisioning
* AI-enhanced infrastructure management

The architecture establishes a foundation for future expansion into:

* Predictive maintenance systems
* AI-driven anomaly classification
* Agentic operational workflows
* RAG-powered operational assistants
* Edge AI inferencing
* Multi-cloud telemetry orchestration
* Autonomous remediation pipelines

---

# Why AWS Was Selected

The AWS-native implementation was selected due to strong alignment with enterprise operational requirements commonly found in:

* Green Energy Platforms
* Smart Grid Infrastructure
* Utility Operations
* Industrial Telemetry Systems
* Distributed Sensor Networks
* Large-Scale Data-Center Operations
* Operational Technology (OT) modernization initiatives

AWS services including IoT Core, Kinesis, Lambda, and Step Functions provide a highly scalable event-driven foundation while enabling rapid delivery of resilient, production-aligned operational workflows.

---

# Future Evolution Path

The architecture is intentionally designed to evolve toward more advanced distributed systems and AI-enabled operational platforms.

```text id="7abmfh"
IoT Telemetry
    ↓
Streaming Event Bus
    ↓
Real-Time Processing
    ↓
AI / ML Inference
    ↓
Operational Decisioning
    ↓
Autonomous Workflow Automation
```

Planned evolutionary directions include:

* Apache Kafka integration
* Temporal.io workflow orchestration
* Kubernetes-native deployment models
* AI-assisted anomaly detection
* RAG-powered operational copilots
* Edge AI processing pipelines
* Predictive infrastructure analytics
* Distributed observability platforms

---

# Industry Alignment

This architecture aligns closely with modern enterprise engineering initiatives focused on:

* AI-ready infrastructure
* Event-driven systems
* Cloud-native operational platforms
* Intelligent telemetry pipelines
* Distributed workflow orchestration
* Industrial IoT modernization
* Smart energy systems
* Observability engineering
* Autonomous operations platforms


---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                        Grid Sensor Pipeline                                 │
  │                                                                             │
  │  [IoT Device / Simulator]                                                   │
  │    Lambda (TypeScript)                                                      │
  │    Publishes to IoT Core topic: sensors/{sensorId}/telemetry                │
  │    Payload: { sensorId, timestamp, readingType, value, unit, gridZone }     │
  │         │                                                                   │
  │         ▼                                                                   │
  │  [AWS IoT Core]  ←── X.509 device auth, device shadows                      │
  │    MQTT broker                                                              │
  │    IoT Rules Engine                                                         │
  │         │                                                                   │
  │    ┌────┴──────────────────────────────────┐                                │
  │    ▼ Rule: all telemetry                   ▼ Rule: value > threshold        │
  │  [Kinesis Data Stream]              [Step Functions]                        │
  │    partition key = sensorId          Alert Workflow                         │
  │    24h retention, replayable         (Standard Workflow)                    │
  │         │                             │                                     │
  │         ▼                             ▼                                     │
  │  [Processor Lambda]            Notify → Wait Ack → Escalate                 │
  │   Kinesis ESM, batch: 10                                                    │
  │   bisectOnError: true                                                       │
  │         │                                                                   │
  │    ┌────┴──────────────────┐                                                │
  │    ▼                       ▼                                                │
  │ [DynamoDB]          [CloudWatch]                                            │
  │  PK: sensorId        EMF metrics via Lambda Powertools                      │
  │  SK: timestamp       → CloudWatch natively                                  │
  │  idempotency key     → Datadog via Lambda Extension (production)            │
  │  TTL: 30 days        X-Ray distributed tracing                              │
  │    │                       │                                                │
  │    ▼                       ▼                                                │
  │  [Query API]         [Alarms + Dashboard]                                   │
  │  API GW → Lambda      DLQ depth · P99 latency · Step Functions failures     │
  │  GET /sensors/{id}/readings?from=&to=                                       │
  │         │                                                                   │
  │         ▼                                                                   │
  │  [SQS DLQ]  ←── failed Kinesis batches after max retries                    │
  │       │                                                                     │
  │       ▼                                                                     │
  │  [DLQ Inspector Lambda]                                                     │
  │   structured log + SNS alert + optional Kinesis replay                      │
  │                                                                             │
  │  [Kinesis Firehose → S3]                                                    │
  │   cold archive — all raw events, Parquet by date/sensorId                   │
  └─────────────────────────────────────────────────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js 20) |
| IaC | AWS CDK v2 |
| Device ingest | AWS IoT Core — MQTT, X.509 auth, rules engine |
| Streaming | Kinesis Data Streams — ordered per sensor, replayable |
| Processing | AWS Lambda — Kinesis ESM, `bisectOnError`, `batchItemFailures` |
| Alert orchestration | AWS Step Functions — Standard Workflow, auditable escalation |
| Validation | Zod — runtime type safety at the I/O boundary |
| Observability | Lambda Powertools (Logger, Tracer, Metrics via EMF) |
| Idempotency | Lambda Powertools Idempotency + DynamoDB |
| Hot storage | DynamoDB — PK: `sensorId`, SK: `timestamp`, TTL 30 days |
| Cold archive | Kinesis Firehose → S3, Parquet |
| Query API | API Gateway + Lambda |
| DLQ | SQS + Inspector Lambda |
| Tracing | AWS X-Ray |
| Observability bridge | Datadog Lambda Extension (zero application code changes) |

---

## Repository Structure

```
grid-sensor-pipeline/
├── src/
│   ├── handlers/
│   │   ├── simulator.ts          # Publishes synthetic events to IoT Core
│   │   ├── processor.ts          # Kinesis ESM → validate → DynamoDB + metrics
│   │   ├── alert-handler.ts      # Invoked by Step Functions — notification step
│   │   ├── dlq-inspector.ts      # SQS DLQ → structured log + SNS alert + replay
│   │   └── query.ts              # API Gateway → DynamoDB range query
│   ├── lib/
│   │   ├── validator.ts          # Zod schema — I/O boundary only
│   │   ├── repository.ts         # SensorRepository — DynamoDB put/query
│   │   ├── threshold.ts          # Threshold evaluation — pure function, no I/O
│   │   ├── types.ts              # SensorEvent, SensorReading, AlertContext
│   │   ├── logger.ts             # Powertools Logger singleton
│   │   ├── tracer.ts             # Powertools Tracer singleton
│   │   └── metrics.ts            # Powertools Metrics singleton
│   └── __tests__/
│       ├── processor.test.ts
│       ├── validator.test.ts
│       ├── threshold.test.ts
│       └── repository.test.ts
├── infra/
│   ├── bin/app.ts
│   └── lib/
│       ├── iot-stack.ts              # IoT Core thing type, policy, rules engine
│       ├── kinesis-stack.ts          # Kinesis stream + Firehose → S3
│       ├── processing-stack.ts       # Processor Lambda + ESM config + DLQ
│       ├── alert-workflow-stack.ts   # Step Functions Standard Workflow
│       ├── storage-stack.ts          # DynamoDB readings + idempotency tables
│       ├── query-stack.ts            # API Gateway + query Lambda
│       └── observability-stack.ts   # CloudWatch Dashboard + Alarms + SNS
├── scripts/
│   └── simulate.ts               # Publish N synthetic sensor events
├── CLAUDE.md
├── cdk.json
├── tsconfig.json
└── package.json
```

---

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- AWS CDK v2 (`npm install -g aws-cdk`)
- An AWS account with permissions for IoT Core, Kinesis, Lambda, DynamoDB, Step Functions, API Gateway, S3, SNS, SQS, CloudWatch

---

## Quick Start

```bash
npm install
npm test          # unit tests
npm run build     # tsc compile check
```

---

## Deploy

```bash
cd infra && npm install

# First time only
cdk bootstrap

# Deploy all stacks
cdk deploy --all

# Deploy a single stack
cdk deploy IotStack
cdk deploy ProcessingStack

# Preview changes
cdk diff

# Tear down (IoT Core charges per message; Kinesis per shard-hour)
cdk destroy --all
```

### Simulate events

```bash
npx ts-node scripts/simulate.ts --count 50
```

Publishes 50 synthetic sensor readings to IoT Core → flows through the full pipeline to DynamoDB.

---

## Key Design Decisions

### Idempotency — Kinesis sequence number as the key

Lambda Powertools' idempotency utility uses DynamoDB as the persistence layer. The idempotency key is the Kinesis sequence number — globally unique per shard, stable across Lambda retries. Combined with a DynamoDB conditional write (`attribute_not_exists(pk)`), the processor is safe to retry without duplicates. Transactional semantics would be overkill here — idempotency at the consumer is cheaper and simpler.

### bisectOnError + batchItemFailures — partial batch failure isolation

Kinesis Lambda ESM with `bisectOnError: true` splits a failing batch in half to isolate the bad record rather than failing the whole batch or silently dropping it. Combined with `batchItemFailures`, only the bad record retries and eventually routes to the DLQ. This is the correct pattern for any at-least-once Kinesis consumer.

### Step Functions Standard Workflow for alert escalation

Alert escalation uses a Step Functions Standard Workflow rather than a Lambda chain. Reasons: (1) auditable execution history — every step, input, output, and transition is retained for 90 days; (2) Wait state for 15-minute acknowledgment window without a running Lambda; (3) per-step retry configuration — a transient notification failure retries that step only, not the whole escalation. A Lambda chain provides none of these guarantees. The tradeoff is more infrastructure; it is worth it for safety-critical workflows.

### IoT Rules Engine routing — telemetry vs. alerts split

Two rules route at the IoT layer: all telemetry to Kinesis, threshold violations directly to Step Functions. The alternative was routing everything to Kinesis and deciding in the processor Lambda. Rules-based routing wins because: the threshold condition is simple SQL evaluable in the rules engine without a Lambda invocation; it decouples the alert path from the data path so a Lambda cold start cannot delay a safety alert; and threshold violations are a small fraction of total telemetry volume, making the dedicated rule operationally cheap.

---

## Observability

**Metrics namespace:** `GridSensorPipeline`

| Metric | Unit | Source |
|--------|------|--------|
| `EventsProcessed` | Count | processor |
| `ProcessingLatencyMs` | Milliseconds | processor |
| `ValidationErrors` | Count | processor |
| `PartialBatchFailures` | Count | processor |
| `DlqMessagesReceived` | Count | dlq-inspector |
| `AlertWorkflowStarted` | Count | IoT Rules Engine (CloudWatch auto) |
| `AlertWorkflowFailed` | Count | Step Functions (CloudWatch auto) |

**Alarms:**
- DLQ depth ≥ 1 → SNS (immediate)
- P99 processing latency > 2000ms for 3 min → SNS
- Step Functions `ExecutionsFailed` ≥ 1 → SNS

### Datadog bridge

The pipeline emits metrics via Lambda Powertools EMF to CloudWatch natively. To forward to Datadog in production, add the Datadog Lambda Extension — zero application code changes required:

```typescript
// In processing-stack.ts
const datadogLayer = lambda.LayerVersion.fromLayerVersionArn(
  this, 'DatadogExtension',
  `arn:aws:lambda:${this.region}:464622532012:layer:Datadog-Extension:65`
);

processorFn.addLayers(datadogLayer);
processorFn.addEnvironment('DD_API_KEY_SECRET_ARN', datadogSecretArn);
processorFn.addEnvironment('DD_SITE', 'datadoghq.com');
processorFn.addEnvironment('DD_SERVERLESS_LOGS_ENABLED', 'true');
```

EMF metrics written to stdout → CloudWatch Logs → Datadog Extension parses and forwards automatically. Structured log fields (`sensorId`, `readingType`, `service`) map directly to Datadog tags.

---

## SensorEvent Schema

```typescript
{
  sensorId:    string   // pattern: sensor-[a-z0-9-]+
  timestamp:   string   // ISO 8601
  readingType: 'voltage' | 'current' | 'frequency' | 'power_factor' | 'temperature'
  value:       number   // finite
  unit:        string   // max 16 chars
  gridZone?:   string   // optional — GSI queries and rules engine filtering
}
```

**Threshold defaults (configurable via CDK context):**
- Frequency: < 59.5 Hz or > 60.5 Hz (NERC ±0.5 Hz standard)
- Voltage: < 114V or > 126V (nominal 120V ±5%)

---

## Estimated Cost

Running actively for a development week: **~$5–10**

| Service | Cost |
|---|---|
| IoT Core | $0.08/M messages + $0.18/M rules triggered — negligible at dev volume |
| Kinesis (1 shard) | ~$0.015/hr ≈ $2.52/week |
| Step Functions | First 4,000 state transitions/month free |
| Lambda, DynamoDB, S3, API Gateway | Free tier at dev volumes |

Run `cdk destroy --all` after dev sessions.

---

## Dependencies

```json
{
  "dependencies": {
    "@aws-lambda-powertools/logger":      "^2",
    "@aws-lambda-powertools/tracer":      "^2",
    "@aws-lambda-powertools/metrics":     "^2",
    "@aws-lambda-powertools/idempotency": "^2",
    "@aws-sdk/client-dynamodb":           "^3",
    "@aws-sdk/client-iot-data-plane":     "^3",
    "@aws-sdk/lib-dynamodb":              "^3",
    "@aws-sdk/client-kinesis":            "^3",
    "zod":                                "^3"
  },
  "devDependencies": {
    "aws-cdk-lib":       "^2",
    "constructs":        "^10",
    "typescript":        "^5",
    "jest":              "^29",
    "ts-jest":           "^29",
    "@types/aws-lambda": "^8"
  }
}
```

---

## License

MIT
