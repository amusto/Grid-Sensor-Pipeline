# Asset Registry Runbook

> **Status: living doc** — updated as the factory-floor registry and the
> enrichment service evolve. Introduced: Phase 15 (P15.1).

> **When to use this.** Any time you need to inspect, validate, or update
> the factory-floor reference data (assets, floor maps, zones, sensor
> mappings) — or debug "why didn't this alert get a location?"

---

## Mental model

Phase 15 enrichment turns a bare `sensorId` into a physical location by
looking it up in an **asset registry** — versioned JSON seed data, not a
live database. Three failure modes are worth defending against:

1. **Stale mapping.** A sensor was re-cabled to a different asset but the
   `SensorMapping` wasn't updated → the alert points at the wrong
   equipment. A *confidently wrong* location is the dangerous failure.
2. **Missing mapping.** A new sensor has no entry yet → enrichment must
   fail safe (location unknown), not crash and not guess.
3. **Malformed seed data.** A hand-edited JSON file drifts from the
   schema → must fail loudly at load (Zod), never silently at lookup.

Defense: the registry is the **single deterministic source of truth**;
the LLM never participates in producing locations
([decision log pre-flight 1](../decisions/phase-15-factory-floor-mapping.md)).
This runbook is the operational reference for keeping that source correct.

The registry seed data lives at:

```
data/factory-floor/
  demo-floor-map.json        # plant → building → floor → zones (polygons)
  demo-assets.json           # assets with location (x, y, rotation) + zone
  demo-sensor-mappings.json  # sensorId → assetId + metric contract
```

---

## Tier 1 — Quick inspection (jq over the seed files)

The fastest way to answer *"what does the registry think right now?"*

```bash
# What asset is a sensor mapped to?
jq '.[] | select(.sensorId=="temp-044") | {sensorId, assetId, metricType, thresholdRange}' \
  data/factory-floor/demo-sensor-mappings.json

# Where is an asset, and what zone is it in?
jq '.[] | select(.assetId=="conveyor-02") | {displayName, lineId, cellId, zoneId, location}' \
  data/factory-floor/demo-assets.json

# List every zone defined on a floor
jq '.zones[] | {zoneId, zoneType, points: (.polygon | length)}' \
  data/factory-floor/demo-floor-map.json

# Find assets that have NO sensor mapping (orphans → will fail-safe at enrichment)
comm -23 \
  <(jq -r '.[].sensorIds[]' data/factory-floor/demo-assets.json | sort -u) \
  <(jq -r '.[].sensorId'   data/factory-floor/demo-sensor-mappings.json | sort -u)
```

---

## Tier 2 — Validate the registry (schema + referential integrity)

Before trusting the seed data, confirm it parses and cross-references
cleanly. Once P15.2 ships the Zod schemas, validation runs through them;
until then these checks catch the common drift.

```bash
# JSON is well-formed
for f in data/factory-floor/*.json; do jq empty "$f" && echo "OK: $f"; done

# Every mapping points at an asset that exists
comm -23 \
  <(jq -r '.[].assetId' data/factory-floor/demo-sensor-mappings.json | sort -u) \
  <(jq -r '.[].assetId' data/factory-floor/demo-assets.json | sort -u)
# (empty output = clean; any line = a mapping referencing a missing asset)

# Every asset's zoneId exists on its floor map
comm -23 \
  <(jq -r '.[].zoneId' data/factory-floor/demo-assets.json | sort -u) \
  <(jq -r '.zones[].zoneId' data/factory-floor/demo-floor-map.json | sort -u)
```

Once the enrichment library exists (P15.3), the authoritative validation
is the unit-test suite:

```bash
npm test -- factory-floor    # registry + enrichment suites
```

---

## Suggested workflow — updating the registry

The minimal loop for the most common task ("a sensor moved / an asset was
added"):

1. **Edit the seed file** under `data/factory-floor/` (mapping, asset, or
   floor/zone).
2. **Validate** — run the Tier 2 referential-integrity checks, then
   `npm test -- factory-floor`.
3. **Spot-check the enrichment** for the affected sensor (Tier 1 jq, then
   confirm the enriched output once P15.3 is wired).
4. **Commit the seed change on its own** — registry edits are reference-data
   changes, kept separate from code changes for clean blame.

Reference data is versioned in git; there is no live-edit path by design
(decision log pre-flight 3). A DynamoDB-backed registry with live edits is
the documented production migration.

---

## What to watch when something seems off

| Symptom | First thing to check | Likely cause |
|---|---|---|
| Alert fired but `locationContext` is `null` | Tier 1: is the `sensorId` in `demo-sensor-mappings.json`? | Missing sensor mapping — enrichment fail-safe fired (`enrichmentStatus: 'sensor_unmapped'`). Add the mapping. |
| Alert points at the wrong equipment | Tier 1: what `assetId` is the sensor mapped to? | Stale mapping — sensor re-cabled but mapping not updated. |
| Enrichment throws / registry won't load | Tier 2: JSON well-formed? schema parse errors? | Malformed seed data — a hand-edit drifted from the schema. |
| Asset has a `zoneId` but enrichment returns no zone | Tier 2: does that `zoneId` exist on the floor map? | Zone referenced by an asset isn't defined in `demo-floor-map.json`. |
| `(x, y)` looks wrong on the floor | Confirm the asset's `location.units` matches the floor map's `units` | Unit mismatch between asset and floor coordinate space. |

---

## Maintenance

This doc is updated when:

| Trigger | Update |
|---|---|
| Registry gains a new entity type (e.g., a `Line` or `Cell` document) | Add inspection + integrity checks for it |
| Zod schemas land (P15.2) | Replace the ad-hoc jq integrity checks with the schema-validation command |
| Enrichment is wired into the alert path | Add a Tier-2 check that confirms `locationContext` reaches the SNS payload |
| Registry migrates to DynamoDB | Replace the seed-file paths with table-inspection commands |

The convention (shared with the other operations docs) is to update this
runbook *in the same commit* as the registry or enrichment change, not as
a follow-up.

---

## Did I actually learn this? — self-test

Without looking back at this doc, can you:

1. **Name the single source of truth** for a sensor's physical location.
   Why must the LLM never produce it?
2. **State what happens** when a `sensorId` has no mapping. Why is
   fail-safe (location unknown) safer than a default location?
3. **Cite the two referential-integrity checks** that catch the most
   common registry drift.
4. **Explain why** the registry is versioned JSON seed data rather than a
   live database for the POC — and what the production migration is.
5. **Describe the update workflow** for "a sensor moved to a different
   asset," start to finish.

If 2 trips you up, reread the Mental model. The fail-safe-over-fabricate
rule is the single most important operational property — a confidently
wrong location during a safety event is worse than an honest unknown.
