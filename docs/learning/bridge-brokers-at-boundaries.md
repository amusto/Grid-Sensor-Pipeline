# Bridge Brokers at Trust / Operational Boundaries

> **Status:** filled — Phase 8 close-out. The pattern this note
> describes is older than this project (the candidate has applied it
> across multiple prior systems in unrelated industries); this note
> formalizes it using the current project as the canonical example.

> **Where this is anchored in the project:**
> - `infra/lib/iot-stack.ts` — AWS IoT Core configuration with the
>   Rules Engine acting as the bridge.
> - `infra/lib/kinesis-stack.ts` — the internal stream the bridge
>   dispatches to.
> - The `AllTelemetryRule` SQL filter — the literal bridge code.
> - System overview diagram: [`../diagrams/system-overview.md`](../diagrams/system-overview.md).

---

## Pattern statement

When external communication uses **one protocol/broker** (constrained
by the device ecosystem, partner systems, B2B agreements, or
regulatory requirements) and internal communication uses **a different
broker** (chosen by you for throughput, scalability, and your
microservice topology), put a **bridge layer at the boundary** that
translates between them.

The deeper principle: **don't let the external protocol dictate your
internal architecture.** The external choice is often someone else's;
the internal choice is yours to optimize. The bridge is the seam.

---

## How this project applies it

```
[Sensors]
   ↓  MQTT (external protocol — chosen by the IoT device ecosystem)
[AWS IoT Core MQTT broker]
   ↓
[IoT Rules Engine]  ← THE BRIDGE — SQL filter + action dispatch
   ↓  Internal protocol — chosen for our pipeline's needs
[Kinesis Data Stream]
   ↓
[Processor Lambda · DynamoDB · Step Functions · ...]
```

Concretely:

- **External boundary:** AWS IoT Core acts as the MQTT broker.
  Devices publish to `sensors/<id>/telemetry`. MQTT is the protocol
  because that's what battery-constrained IoT devices speak natively
  — low overhead, persistent connections, QoS levels for unreliable
  networks. *We don't choose MQTT; the device ecosystem does.*
- **The bridge:** IoT Rules Engine. SQL-like filtering at the edge
  (`SELECT *, topic(2) AS sensorId FROM 'sensors/+/telemetry'`),
  dispatching matched events to Kinesis with `sensorId` as the
  partition key. Two rules run in parallel — `AllTelemetryRule`
  (every reading → Kinesis) and `ThresholdAlertRule` (only breaches
  → Step Functions). Both rules are *bridge logic.*
- **Internal:** Kinesis Data Stream. We chose Kinesis because:
  partitioned-by-sensorId parallelism, replayable 24-hour retention,
  clean Lambda ESM integration with partial-batch-failure handling.
  Downstream consumers (the processor Lambda, the analytics Firehose,
  any future consumer) speak Kinesis — they don't know MQTT exists.

---

## Why this pattern matters

Three principles encoded in the choice.

### 1. Translation lives at the boundary, not inside

Every internal consumer speaks the internal protocol. The processor
Lambda receives Kinesis records, not MQTT messages. Future consumers
of the same data — the analytics archive, the query API,
hypothetically a new alert pipeline — all speak Kinesis. **None of
them know what MQTT is.** That's a feature: the internal services
stay clean, testable, and decoupled from the boundary protocol's
quirks.

This is the same principle as *parse-don't-validate at the I/O
boundary* (see [`../learning/_design-patterns-index.md`](./_design-patterns-index.md)
under "I/O boundary patterns"), applied to protocol mediation rather
than data validation. Same architectural commitment, different
concern.

### 2. The bridge is small, focused, and well-tested

The IoT Rules Engine has minimal logic: a SQL filter + an action.
That's the entire bridge. It's not running business logic. It's not
making decisions that need code review. It's translating one
protocol's events into another protocol's events, with one
side-effect — partitioning by sensor ID for downstream affinity.

Doing little is the point. When a system fails at scale, the bridge
should be the *easiest* layer to diagnose — because it does the
least.

### 3. The bridge is the natural deduplication point

If the external protocol has at-least-once delivery semantics
(MQTT QoS 1 can deliver duplicates; some broadcast protocols are
heard by multiple receivers simultaneously), the bridge is the
natural place to enforce uniqueness before the internal pipeline
sees the event.

In this project, dedup happens downstream at the Kinesis sequence-
number layer (idempotency table + conditional writes). That's a
*placement choice* — for our duplication factor (low), downstream is
simpler. **At higher duplication factors** — for example, RF
broadcast protocols where the same message is heard by 5-10
receivers simultaneously — upstream dedup at the bridge becomes
materially more efficient. *Dedup placement is scale-dependent and
worth being deliberate about.*

---

## When this pattern is the right choice

Several signals worth recognizing:

- **The external protocol isn't yours to choose.** Device firmware
  ships with MQTT support; satellite ground stations speak JMS/AMQP;
  legacy enterprise partners speak EDI; aviation broadcasts ADS-B.
  Trying to force the external system to speak your internal
  protocol is either impossible (firmware) or politically expensive
  (partner contracts).
- **Internal scale and throughput needs differ from the external
  protocol's design.** MQTT scales fine to thousands of low-rate
  devices; it's not the protocol you want for the high-throughput
  microservice mesh consuming the data. Kafka or Kinesis is.
- **Multiple internal consumers want the same external events.**
  The bridge fans out — every internal consumer subscribing to the
  internal broker gets the event without re-implementing external
  protocol handling.

## When NOT to use this pattern

A few signals that a bridge is over-engineering:

- **Single internal consumer.** If exactly one service reads the
  external feed, an internal broker buys you little. The single
  consumer can speak the external protocol directly.
- **External protocol IS your internal protocol.** If everyone in
  your system speaks Kafka, you don't need a bridge — you have a
  shared message bus.
- **External volume is trivial.** A handful of events per day
  doesn't justify the operational overhead of two brokers + a
  bridge.

---

## Operational cost worth being honest about

Two brokers is more operational surface than one:

- More monitoring (broker health on both sides).
- More security boundaries (auth happens at each broker).
- More deploy coordination (changes can affect either layer).
- More cost (the bridge itself is a deploy unit, however small).

This is the trade-off you accept to preserve a design property —
internal architecture independence from external protocol choices.
That's a *deliberate* cost, not an accidental one.

---

## Did I actually learn this?

Self-test gates — close the file and try to answer these from memory
before peeking:

1. *What single architectural principle does this pattern protect?*
   (Internal architecture independence from external protocol choices.)
2. *Why is the bridge the natural deduplication point?* (Because if
   the external protocol can deliver duplicates, dedup at the boundary
   means downstream consumers see clean events — they don't each
   re-implement the dedup logic.)
3. *Name three external protocols that commonly drive this pattern.*
   (MQTT for IoT, JMS/AMQP for enterprise integration, broadcast
   protocols like ADS-B for surveillance.)
4. *When should you NOT use this pattern?* (Single internal consumer,
   shared internal protocol matches external, trivial volume.)
5. *Why is the bridge "small, focused, well-tested" non-negotiable?*
   (Because it's a single point of correctness at the system's most
   visible boundary — bugs in the bridge affect every internal
   consumer simultaneously.)

---

## Related patterns

- **Parse-don't-validate at the I/O boundary** —
  [`./_design-patterns-index.md`](./_design-patterns-index.md) under
  "I/O boundary patterns". Same architectural commitment applied to
  data shape rather than protocol mediation.
- **Decoupled storage + alerting paths** — visible in
  [`../diagrams/system-overview.md`](../diagrams/system-overview.md).
  The pattern works at the protocol layer (this note) AND at the
  routing layer (every reading archived; only breaches alerted).
- **Composition over replacement at the right layer** —
  [`./langchain-langgraph.md`](./langchain-langgraph.md). Step
  Functions for the durable outer workflow; LangGraph for the
  agentic inner flow. Same broader principle: each tool at the
  layer where it's strongest.
