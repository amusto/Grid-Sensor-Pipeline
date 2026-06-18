# Phase 15 — Factory Floor Mapping & Asset Intelligence

Status: **pre-flight** (P15.1 — documentation). Extends the pipeline from
*telemetry-centric* to *asset-centric*: a sensor event is no longer just an
abstract reading, it resolves to a real (or simulated) factory-floor asset and
its physical context — building, floor, line, cell, zone, and indoor (x, y)
coordinates.

This is the phase that turns *"sensor temp-044 read 185°C"* into *"Conveyor 02
on Line 1, Cell A, Building A is overheating — here's where to send someone."*

The conceptual evolution:

```
Current:  sensor telemetry → anomaly/rule evaluation → alert
Target:   sensor telemetry → sensor-to-asset lookup → asset location lookup
          → zone/floor context enrichment → alert / NotifyOps response
```

For each decision: **concept · alternatives · cost lens · tradeoff knowingly
accepted.**

> **Drafted under timeline-priority mode (2026-06-18).** This log is
> Claude-drafted; it needs an Armando voice pass before public publication,
> consistent with the P9.5 learning-note convention. See
> [`../../../shared/practice/collaboration-mode.md`](../../../shared/practice/collaboration-mode.md).

---

## Why "Phase 15" and not "Phase 9"

The feature was requested as "Phase 9," but Phase 9 (Agentic Case Routing)
shipped on 2026-05-13 and is referenced throughout the repo. Renumbering it
would break every existing cross-link. This work is a post-POC capability
extension, so it takes the next free number after the P13/P14 stretch slots —
**Phase 15** — and uses the repo's existing dot sub-phase notation
(**P15.1 / P15.2 / P15.3**) rather than an A/B/C scheme the repo doesn't use.

The requested `ADR-012-*` filename was also mapped to the repo's actual
decision-log convention (`phase-NN-<short>.md`, indexed in
[`README.md`](./README.md)) — the project does not use ADR-NNN numbering.

---

## P15 pre-flight 1 — Deterministic services own all factual mapping (the load-bearing decision)

**Concept.** Physical-location facts are *data lookups*, not *inferences*. The
mapping from a sensor to its asset, from an asset to its coordinates, and from
an asset to its zone is owned entirely by deterministic services backed by an
asset registry. The LLM / LangGraph layer (Phase 8/9) receives the
already-enriched `locationContext` as structured input and only summarizes,
reasons over, and generates recommendations from it.

**Decision.** No LLM call appears anywhere in the enrichment path. The
`enrichTelemetryEvent()` function and the `asset-registry` lookups are pure,
synchronous, deterministic code. The LLM is downstream and read-only with
respect to location: it may write *prose* about a location, never the location
itself.

**Alternatives.**

- **Let the LLM resolve locations from context.** Tempting — "the model knows
  Conveyor 02 is on Line 1." Rejected outright: a model that *guesses* a
  physical location will eventually guess wrong, and an operator dispatched to
  the wrong cell during a thermal event is a safety failure, not a UX bug.
  Location is exactly the class of fact that must never be hallucinated.
- **Hybrid — LLM resolves, deterministic service validates.** Adds latency and
  a validation surface for zero benefit; the registry already has the answer.
- **Deterministic only (chosen).** The registry is the single source of truth;
  the LLM consumes its output.

**Why this is the load-bearing decision.** It preserves the Phase 8 fail-soft
AI contract. If Bedrock is unavailable, the alert still carries full, correct
location context — because that context was produced deterministically before
the LLM was ever invoked. AI degrades gracefully; location facts never degrade.

**Cost lens.** Zero LLM tokens spent on location. Enrichment is in-memory
lookups against seed data — microseconds, no API calls, no per-event cost.

**Tradeoff accepted.** The registry must be kept accurate; a stale mapping
produces a confidently-wrong location. Mitigation: the registry is versioned
seed data with a documented update runbook
([`../operations/asset-registry-runbook.md`](../operations/asset-registry-runbook.md)),
and unknown sensors fail safe (pre-flight 4) rather than guessing.

---

## P15 pre-flight 2 — Indoor coordinate system replaces GPS/GIS (the ERIP adaptation)

**Concept.** This feature adapts the GPS/GIS location-and-routing model from
the ERIP emergency-response POC to indoor manufacturing. Outdoors, ERIP uses
latitude/longitude and a road graph to route responders to emergency
resources. Indoors, GPS doesn't penetrate and lat/long has no meaning at
shop-floor resolution.

**Decision.** Model location as a **per-floor local Cartesian coordinate
system**: each `FloorMap` defines its own origin, `width`, `height`, and
`units` (e.g., meters), and every `Asset` carries a `location: { x, y,
rotation, units }` within its floor. Zones are polygons in the same coordinate
space. There is no global coordinate — location is always
`(plantId, buildingId, floorId)` + local `(x, y)`.

**Alternatives.**

- **Reuse lat/long.** Wrong tool indoors; precision and semantics both fail.
- **Single global grid across all buildings.** Forces artificial offsets and
  makes per-floor maps awkward; couples buildings that should be independent.
- **Per-floor local coordinates (chosen).** Matches how facility CAD/BIM and
  RTLS systems actually model space; each floor is self-contained.

**Why per-floor local.** It mirrors the real domain (a floor plan is its own
coordinate space), keeps `FloorMap` documents independent, and leaves a clean
seam for a future CAD/BIM import (a non-goal now) to populate the same shape.

**Cost lens.** Pure data modeling — no runtime cost.

**Tradeoff accepted.** Cross-building distance/routing is undefined in this
model. That's intentional — routing is an explicit non-goal (pre-flight 6).
When routing lands, it operates *within* a floor's coordinate space first.

---

## P15 pre-flight 3 — Asset registry as seed data, not a live service

**Concept.** The asset registry, floor maps, zones, and sensor mappings are
relatively static reference data. For the POC they ship as versioned JSON seed
files, loaded into an in-memory registry — not a database or external service.

**Decision.** Seed data lives at `data/factory-floor/`
(`demo-floor-map.json`, `demo-assets.json`, `demo-sensor-mappings.json`). The
`asset-registry` module loads and indexes them once; lookups are O(1) map
reads. The repo has no `data/` or `seeds/` directory today (synthetic
*telemetry* is generated in code by the simulator), so `data/factory-floor/`
is a newly proposed, convention-fitting home for static reference data —
distinct from generated telemetry.

**Alternatives.**

- **DynamoDB asset table.** Production-shape, but adds a table, IAM, and a CDK
  stack for data that doesn't change per event. Documented as the production
  migration path; out of scope for the deterministic-foundation phase.
- **Hard-code the registry in TypeScript.** Couples reference data to code;
  every floor-plan tweak becomes a code change and redeploy.
- **JSON seed files + in-memory index (chosen).** Editable without code
  changes, trivially testable, and the obvious migration seam to DynamoDB
  later (swap the loader, keep the registry interface).

**Cost lens.** Zero — files bundled with the code, loaded once.

**Tradeoff accepted.** No live updates without a redeploy/reload. Fine for a
demo; the registry interface is the swap point for a DynamoDB-backed loader
when live edits matter.

---

## P15 pre-flight 4 — Missing-mapping fail-safe (no throw, structured skip)

**Concept.** Not every sensor will have an asset mapping (new sensor,
registry lag, typo). The enrichment service must handle this without throwing
and without inventing a location.

**Decision.** When `enrichTelemetryEvent()` can't resolve a `sensorId` to an
asset, it returns a structured result the caller can branch on — the original
event plus an explicit "enrichment unavailable" signal (e.g.,
`locationContext: null` with a `enrichmentStatus` reason) — rather than
throwing or fabricating a `locationContext`. The alert path stays alive; the
operator gets the raw reading with an honest "location unknown" rather than a
wrong location.

**Alternatives.**

- **Throw on missing mapping.** Turns a data-quality gap into a pipeline
  failure; a single unmapped sensor would break alerting.
- **Default/placeholder location.** Worst option — a confident-but-fake
  location is more dangerous than an admitted-unknown one.
- **Structured skip (chosen).** Mirrors the Phase 8 fail-soft pattern and the
  Phase 9 partial-success pattern: degrade with a typed signal, never crash,
  never lie.

**Why this mirrors existing patterns.** It's the same "exception-as-
information / fail-soft" discipline already documented in
[`../learning/case-management-patterns.md`](../learning/case-management-patterns.md)
— a recognized result shape beats a thrown error at a boundary the caller can
reason about.

**Cost lens.** Zero.

**Tradeoff accepted.** Callers must check `enrichmentStatus`. Documented in
the type and the handoff spec; tested explicitly (one of the seven P15.3 test
cases).

---

## P15 pre-flight 5 — Enriched event is additive, not a replacement

**Concept.** The `EnrichedTelemetryEvent` should carry the alerting fields
NotifyOps/LangGraph already expect *plus* a nested `locationContext` — it must
not break the existing `SensorEvent` / `AlertContext` contracts.

**Decision.** `EnrichedTelemetryEvent` includes the breach-relevant fields
(`eventId`, `sensorId`, `assetId`, `assetName`, `severity`, `metricName`,
`metricValue`, `threshold`, `timestamp`) and a nested `locationContext`
(`plantId`, `buildingId`, `floorId`, `lineId`, `cellId`, `zoneId`, `x`, `y`).
It is produced by the enrichment service and handed to the LLM layer as
structured input. Existing types are untouched.

**Alternatives.**

- **Mutate `SensorEvent` to add location.** Pollutes the ingest/validation
  contract with downstream concerns; violates the I/O-boundary discipline.
- **Separate enriched type (chosen).** Keeps the ingest contract pure and the
  enriched shape explicit; the enrichment service is the only producer.

**Cost lens.** Zero.

**Tradeoff accepted.** Two related types to keep coherent. Mitigation: Zod
schemas in `schemas.ts` are the single source of truth; types are inferred.

---

## P15 pre-flight 6 — Explicit non-goals (scope fence)

This phase builds the **deterministic foundation only**. The following are
explicitly **out of scope** and must not be built in P15.1–P15.3:

- React / map UI for the factory floor.
- Indoor routing / path-graph logic (the ERIP "route to resource" analogue).
- BLE / UWB worker-tracking integration.
- CAD / BIM file import.
- Any LLM-derived location inference (directly contradicts pre-flight 1).
- A new documentation organization that conflicts with existing repo
  conventions.

**Why fence the scope.** Each excluded item is a phase-sized effort on its own.
The asset registry + coordinate model + deterministic enrichment are the
load-bearing primitives everything else composes on; shipping them first,
correctly, is worth more than a thin slice of all of them. This is the same
scope-discipline call recorded for P9 (five channels → two) and P12 (build →
docs-only).

---

## Cross-cutting framing for Phase 15

Three durable patterns this phase encodes:

1. **Facts are deterministic; narrative is generative.** The registry owns
   locations; the LLM owns prose about locations. The boundary between "what is
   true" and "how we describe it" is enforced in code, not convention. This is
   the asset-centric counterpart to Phase 8's "validate at the I/O boundary."

2. **Fail-safe enrichment over fail-fast.** A missing mapping degrades to an
   honest "location unknown," never a crash and never a fabricated location —
   the same exception-as-information discipline from Phases 2, 8, and 9, applied
   to a new boundary.

3. **Static reference data as a swappable seam.** JSON seed today, DynamoDB
   tomorrow, CAD/BIM-fed eventually — the registry *interface* is the stable
   contract; the loader behind it is the migration point. Same shape as the
   Phase 9 channel-adapter and email SNS→SES seams.
