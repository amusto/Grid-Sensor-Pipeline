# Synthetic Data & Simulation Patterns

> **Status: filled** — added in Phase 4 alongside the simulator
> implementation.

> **Where this is used in the project:** `src/handlers/simulator.ts`
> (Gaussian payload generator + breach mode), `scripts/simulate.ts`
> (CLI driver). Decision rationale lives in
> [`docs/decisions/phase-04-iot-simulator.md`](../decisions/phase-04-iot-simulator.md).

---

## Mental model

A simulator's job is to feed your system inputs that exercise its code
paths *truthfully* — meaning the inputs look like the real ones a
reviewer would expect, *and* the inputs cover the failure modes you
care about.

Two distinct generation regimes:

- **Organic** — values drawn from a realistic distribution. Useful for
  load testing, dashboard validation, "does the happy path stay
  happy under volume?"
- **Adversarial** — values deliberately constructed to drive a specific
  code path. Useful for "does the failure path actually fire?"

A *good* simulator supports both behind a single, narrow flag. The same
generator code produces both modes — no separate "test simulator" that
can drift away from the "real simulator."

---

## Core concepts

### Organic generation: what does "realistic" mean?

Real sensor readings cluster around a nominal value with random noise.
The noise comes from many small independent sources — thermal drift,
electronic interference, sampling jitter, calibration error — and the
**central limit theorem** says the sum of many small independent
random sources approaches a *normal distribution* (a.k.a. Gaussian
distribution, a.k.a. bell curve), regardless of the individual sources'
distributions.

That's why Gaussian is the default choice for sensor noise: it's the
mathematically correct shape for "many small things adding up."

### Adversarial generation: deliberately out-of-bounds

When you want to test a threshold check, a validator, or an alert
predicate, organic generation is the wrong tool. With a tight Gaussian
around a nominal value, breaches are vanishingly rare:

- Voltage Gaussian N(120, 1.5²) puts ~99.7% of values inside
  [115.5, 124.5] V.
- The threshold band is [114, 126] V.
- Probability of an organic breach: **~0.001 per reading** (way out
  in the tails).

You'd need to publish ~1000 organic readings to expect one breach.
That's a flaky, slow test. Adversarial mode says: "I'm going to
*construct* values that I know are out-of-band, so the alert path is
guaranteed to fire."

---

## Gaussian distribution — what you need to know

### The bell curve, in pictures

Two parameters define a Gaussian:

- **μ (mu, mean)** — the center, the value most likely to come out.
- **σ (sigma, standard deviation)** — how spread out the values are.

```
        ╱╲           ← μ (peak of the curve)
       ╱  ╲          ← values near the mean are most likely
      ╱    ╲
   ╱        ╲
__╱          ╲__     ← values far from the mean are rare
   |        |
   μ-σ      μ+σ      ← σ is the width of the "shoulder"
```

### The 68 / 95 / 99.7 rule

A normal distribution has very predictable concentration around the mean:

| Range | Probability of falling in this range |
|---|---|
| μ ± 1σ | 68.3% |
| μ ± 2σ | 95.4% |
| μ ± 3σ | 99.7% |
| μ ± 4σ | 99.994% |
| μ ± 5σ | 99.99994% |

This is the *66-95-99.7 rule* (or *empirical rule*). It's the single
most useful intuition you can carry around about Gaussians: about
two-thirds of values are within one standard deviation of the mean,
about 95% within two, and basically everything within three.

### Applied to this project

Pick voltage as an example. The simulator generates `N(120, 1.5²)`:

- μ = 120 V
- σ = 1.5 V

Concentrations:

| Range | Bound | Probability |
|---|---|---|
| Within 1σ | [118.5, 121.5] V | 68% |
| Within 2σ | [117.0, 123.0] V | 95% |
| Within 3σ | [115.5, 124.5] V | 99.7% |
| Below 114 V | (low threshold breach) | ~0.04% |
| Above 126 V | (high threshold breach) | ~0.04% |

So organic mode produces a breach roughly **once every ~1250
readings**. Way too rare for fast-feedback testing. Hence breach mode.

### Choosing σ

Picking the standard deviation is a judgment call about the noise
floor:

- **Too tight** (σ small) → unrealistic; values look implausibly clean.
- **Too loose** (σ large) → unrealistic the other way; noise dominates
  the signal.

Useful heuristic: **σ ≈ 1% of the nominal value** for high-quality
industrial sensors. That gives you a ~3% spread (3σ), which matches
typical commercial sensor specifications. The simulator uses:

| Reading | μ | σ | σ as % of μ |
|---|---|---|---|
| voltage | 120 V | 1.5 V | 1.25% |
| current | 15 A | 1 A | 6.7% |
| frequency | 60 Hz | 0.1 Hz | 0.17% |
| power_factor | 0.95 | 0.02 | 2.1% |
| temperature | 25 °C | 3 °C | 12% |

Frequency is intentionally tighter (grid frequency is regulated to
much higher precision than voltage). Temperature is looser (real
ambient temperature swings more than a tenth of a percent).

---

## Box-Muller transform — how we actually generate Gaussians

`Math.random()` in JavaScript gives you a **uniform distribution** on
[0, 1) — every value equally likely. To convert that into a *normal*
distribution, you need a transformation. The simplest and most common
is the **Box-Muller transform**:

```ts
const randomNormal = (mean: number, stdev: number): number => {
  const u = 1 - Math.random();   // (0, 1] — exclude exact zero
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdev;
};
```

What's happening mathematically:

1. Take two uniform random numbers, `u` and `v` in (0, 1].
2. Treat `(sqrt(-2 ln u), 2π v)` as polar coordinates of a point.
3. Convert to Cartesian — the result `z = sqrt(-2 ln u) * cos(2π v)` is
   distributed as `N(0, 1²)` (standard normal, mean 0, std dev 1).
4. Scale and shift: `mean + z * stdev` gives `N(mean, stdev²)`.

The "magic" is in step 3: the polar form lands you on a 2D Gaussian
density, and the projection onto a single axis gives you a 1D Gaussian.

### Why Box-Muller specifically

- **Pure function** — given two uniform inputs, you get one Gaussian
  sample. Easy to test.
- **No tables, no conditionals** — just a few arithmetic operations.
- **Numerically stable** — the `1 - Math.random()` guards against
  taking `log(0)`.
- **Throws away half the output** — the same polar conversion produces
  two Gaussian samples (using `cos` and `sin`); we only use the cosine
  half. There's a more efficient variant called *Marsaglia polar* that
  uses both, but for our volume the savings are nil.

### Alternatives

- **Inverse CDF** — accurate but expensive (the inverse of the
  Gaussian CDF has no closed form; needs a polynomial approximation).
  Used by libraries that prioritize accuracy over speed.
- **Ziggurat algorithm** — faster than Box-Muller for high volume but
  much more code. Not worth it here.

---

## Breach mode — the design pattern

The pattern is: **a single flag toggles the generator from organic to
adversarial without changing the rest of the simulator**.

### What changes between modes

```ts
const generateValue = (rt: ReadingType, breach: boolean): number => {
  if (breach && rt === 'voltage') {
    return Math.random() < 0.5
      ? randomNormal(110, 1)   // below threshold (114)
      : randomNormal(130, 1);  // above threshold (126)
  }
  if (breach && rt === 'frequency') {
    return Math.random() < 0.5
      ? randomNormal(59.0, 0.1)
      : randomNormal(61.0, 0.1);
  }
  // ...organic mode for everything else
};
```

Three deliberate choices in the breach path:

1. **Tight σ.** Breach σ (1 V or 0.1 Hz) is smaller than organic σ.
   The point is "guaranteed out-of-band," so we keep the values
   clustered near the breach center — no near-boundary noise that
   could accidentally pass the threshold check.

2. **Bimodal distribution (50/50 below/above).** Sensors fail in two
   regimes — drift-low (degraded contact, brownout) and drift-high
   (overload, spike). A unimodal "always 200 V" simulator only
   exercises one branch of the threshold predicate. Bimodal exercises
   both with equal probability.

3. **Other reading types stay organic.** Only `voltage` and `frequency`
   have threshold rules in this project. `current`, `power_factor`,
   and `temperature` always pass validation but never trigger alerts,
   so there's no "breach" to manufacture for those types.

### Why the pattern matters

A common anti-pattern: building a *separate* "test mode" simulator
that produces only out-of-band values. Two simulators are two things
to maintain, two things that can drift apart. When the production
schema changes, the test simulator gets forgotten and starts emitting
invalid payloads that don't even reach your threshold check.

The `breach: boolean` parameter keeps both modes inside the same
generator function — schema changes, validation rules, and payload
shapes are shared. Only the *value generation* branches.

### Generalizing — fault injection

Breach mode is one specific case of a broader pattern: **fault
injection**. Other failure modes worth considering for a more mature
simulator:

| Fault | What it tests |
|---|---|
| Out-of-range value (this project) | Threshold predicate |
| Malformed payload (missing required field) | Validator |
| Stale timestamp (old data) | Time-window logic |
| Duplicate sequence (same record twice) | Idempotency |
| Burst (1000 records in 100ms) | Backpressure / throttling |
| Sustained drift (slow trend out of band) | Anomaly detection |

Each becomes a flag on the simulator. The existing `--breach` is a
single point on this design space.

---

## Project anchors

- **`src/handlers/simulator.ts`**:
  - `randomNormal(mean, stdev)` — Box-Muller implementation, lines
    ~88–94.
  - `generateValue(rt, breach)` — branches between organic and
    adversarial, lines ~100–125.
  - `DEFAULT_SENSORS` — fixed pool of five sensor IDs (`sensor-001`
    … `sensor-005`).
- **`src/lib/threshold.ts`**:
  - `DEFAULT_THRESHOLDS` — the breach targets (NERC ±0.5 Hz, 120 V
    ±5%). Both pieces of code reference the same nominal values.
- **`scripts/simulate.ts`**:
  - `--breach` flag plumbing — passed straight through to the Lambda
    invocation payload.

---

## Pitfalls

1. **Modeling all readings as the same Gaussian.** Different sensor
   types have different noise floors. A flat σ across all reading
   types either looks unrealistic for tight-tolerance signals
   (frequency) or boring for loose ones (temperature).

2. **Forgetting that `Math.random()` is uniform, not Gaussian.**
   `randomNormal` is a few lines of code; using `Math.random() *
   range + offset` directly gives you uniform-distributed values, not
   bell-curve-distributed. Looks superficially fine; statistically
   wrong.

3. **Adversarial mode that defeats the validator instead of the
   threshold.** A "breach" voltage of `Infinity` would fail Zod's
   `.finite()` check and never reach the threshold predicate. Make
   sure breach values are *valid* but *out-of-bounds* — exercise the
   downstream code path, not the upstream rejection.

4. **Random partition keys defeating ordering tests.** This project's
   simulator uses a fixed pool of 5 sensors. With Kinesis's
   per-partition ordering guarantee, that means each sensor's
   timeline is preserved. A simulator that generated random
   `sensor-${uuid()}` values would produce one record per partition
   and never test ordering.

5. **Treating the simulator as production code.** It's not. The
   simulator's job is to feed the pipeline truthfully — accuracy,
   realism, deterministic-when-needed. It's *not* designed for
   throughput, multi-region resilience, or production observability.
   Don't apply production engineering bars to it.

---

## Cost lens

A simulator's cost shape is driven by **how often you run it × how
expensive each run is**.

- **Organic load testing** — you want big counts, small per-record
  cost. Optimize for throughput. The simulator Lambda's per-invocation
  IoT publish cost (~$0.08/M messages) dominates.
- **Adversarial breach testing** — you want small counts, surgical
  precision. Cost is irrelevant.

For this project's POC volume, total simulator cost is rounding-error.
At scale (100K events/hour for ongoing dashboard validation), the IoT
ingress cost becomes meaningful and is worth tracking.

---

## When to revisit this note

- Before adding new fault-injection modes to the simulator.
- When designing a simulator for a different system — the patterns
  generalize.
- During interview prep — "how would you test that the alert fires?"
  is a natural question.
- When the σ values feel wrong (e.g., a dashboard shows too much
  jitter or not enough).

---

## Did I actually learn this? — self-test

Without looking back at this note, can you:

1. **State the 68/95/99.7 rule in one breath.** What does each number
   represent?
2. **Explain why Gaussian is the natural default for sensor noise.**
   What theorem makes it the right answer rather than "uniform
   random"?
3. **Name the three deliberate choices in breach mode** and why each
   is intentional rather than incidental.
4. **Justify why the simulator uses a fixed pool of 5 sensor IDs
   instead of random UUIDs.** What test property does this preserve?
5. **Explain the organic-vs-adversarial split in one sentence each.**
   When would you reach for one over the other?
6. **Cite an alternative distribution to Gaussian** and the kind of
   data it's better for.
7. **Walk through one round of Box-Muller** — given two uniform
   numbers, what's the math, and why does it produce a Gaussian?

If 7 trips you up, that's fine — Box-Muller's intuition takes time.
The 3Blue1Brown video linked above is the single best resource. But
you should be able to explain *why* a transformation from uniform to
Gaussian is needed even if the specific math doesn't stick.

If 4 trips you up, reread the "Pitfalls" section — the partition-key
distribution test only works because of bounded sensor IDs.

---

## Learning resources

### Probability and statistics

- **3Blue1Brown — "Why π is in the formula for the normal
  distribution"** — beautiful 30-minute video explaining where the
  Gaussian comes from, including a visual derivation of the
  Box-Muller transform. The single best resource for building
  intuition: https://www.youtube.com/watch?v=cy8r7WSuT1I
- **Khan Academy — Normal Distribution** — slower, more conventional;
  good if 3Blue1Brown moves too fast:
  https://www.khanacademy.org/math/statistics-probability/modeling-distributions-of-data/normal-distributions-library/v/introduction-to-the-normal-distribution
- **Wikipedia — Box-Muller transform** — readable for a math article;
  the "Polar form" subsection is the Marsaglia variant if you want
  the more efficient version: https://en.wikipedia.org/wiki/Box%E2%80%93Muller_transform
- **Wikipedia — Central limit theorem** — explains why Gaussian is
  the "default" noise distribution. Skip the proofs:
  https://en.wikipedia.org/wiki/Central_limit_theorem

### Synthetic data and simulation

- **Faker.js (and ports)** — the de facto library for generating
  synthetic data (names, addresses, etc.). Worth knowing about even if
  you don't use it: https://fakerjs.dev/
- **Honeycomb engineering blog — "How we built our load testing
  framework"** — practical view of how a real serverless platform
  generates synthetic load: https://www.honeycomb.io/blog
- **"Property-Based Testing with PropEr/Erlang" (Hebert)** — the book
  that taught me why generated test data is more effective than
  example-based tests. Concepts apply directly to simulator design.

### Fault injection (the broader pattern)

- **Netflix Chaos Engineering** — the canonical writeup. Fault
  injection at the infrastructure layer rather than the data layer,
  but the same mindset:
  https://netflixtechblog.com/the-netflix-simian-army-16e57fbab116
- **AWS Fault Injection Service docs** — what AWS-native fault
  injection looks like for production-grade testing:
  https://docs.aws.amazon.com/fis/latest/userguide/

### Distributions other than Gaussian

When Gaussian isn't the right fit:

- **Poisson** — discrete event counts (errors per minute, requests
  per second). Use when you're modeling "how many things happened"
  rather than "what value did the thing have."
- **Exponential** — wait times between events. Useful for simulating
  inter-arrival jitter.
- **Pareto / power-law** — heavy-tailed phenomena (file sizes, user
  popularity). Useful when "average" is misleading because outliers
  dominate.
- **Beta** — bounded values like probabilities or rates. Useful for
  things like `power_factor` (always in [0, 1]) where Gaussian's
  unbounded tails would produce invalid values.

For this project, Gaussian is sufficient because all the readings we
care about are continuous, real-valued, and centered on a nominal
operating point. If we ever simulate *event arrival patterns*
(Phase 6+ load testing), we'd reach for Poisson or exponential.
