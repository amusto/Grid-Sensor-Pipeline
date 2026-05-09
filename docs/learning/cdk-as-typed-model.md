# CDK as a Typed Model Spanning Runtime + Infrastructure

> **Status: filled** — added in Phase 5 alongside the alert workflow
> implementation, after observing the pattern across all five CDK
> stacks in this project.

> **Where this is anchored in the project:** every file under `infra/`,
> the handler files in `src/handlers/`, and the cross-cutting decision
> logs (`docs/decisions/`).

---

## Mental model

CDK's defining property — the one that distinguishes it from Terraform,
CloudFormation, and Pulumi-Terraform-style approaches — is that
**infrastructure code is written in the same language as application
code, with the same type system, the same toolchain, and the same
testing primitives.**

The deeper claim this enables: **codify invariants at the highest level
the language can express them.** CDK puts stack composition at the
*type* level — constructor props, typed `readonly` fields, interface
inheritance. The compiler catches what would otherwise be runtime
errors. Pulumi (TypeScript or Python flavor) has the same property.
Terraform and CloudFormation are configuration languages — invariants
only show up at the JSON Schema level, not at the symbol level.

If you take one thing from this note, take this: CDK's value is *not*
"infra in code" (Terraform also calls itself that). It's **a single
typed model that spans runtime and infrastructure**, with the type
system as the contract enforcer.

---

## Core concepts

### A "typed model" — what does that mean concretely?

Three properties of CDK that together compose the typed-model story:

1. **Symbols cross the runtime/infra boundary unchanged.** A
   `SensorEvent` interface defined in `src/lib/types.ts` is the same
   symbol referenced by a handler that puts records to DynamoDB and
   by a CDK stack that creates the table that holds those records.
   The compiler tracks the symbol; renaming it propagates everywhere.

2. **Cross-stack contracts are TypeScript interfaces.** When
   `IotStack` says `alertStateMachine?: sfn.IStateMachine`, that's
   not a configuration entry — it's a TS prop. Pass a `Function`
   instead and the compiler refuses to synth. Pass `undefined` and
   the (optional) IoT rule simply isn't created. No runtime check,
   no string lookup, no glue.

3. **Tests are tests.** Stack assertions use Jest, ts-jest, and
   `Match.objectLike` from `aws-cdk-lib/assertions`. Lib tests use
   the same Jest, ts-jest, and `expect`. There's no separate "infra
   test" toolchain to learn or maintain.

### L1 / L2 / L3 — construct abstraction layers

CDK constructs come in three flavors. Knowing which is which shapes
the typed-model leverage:

| Layer | What it is | Typed-model value |
|---|---|---|
| **L1** (Cfn-prefixed) | Direct CFN resource bindings, JSON-shaped properties, generated from CFN spec | Lowest. You get TS types but they mirror the CFN spec verbatim. |
| **L2** | Hand-written TS classes that wrap L1, expose ergonomic methods (`grantRead`, `addToPolicy`), defaults | Highest. The "value layer" — methods like `stream.grantRead(role)` encode the operational contract. |
| **L3** (Patterns) | Composed L2 constructs encoding architectural patterns (e.g., `ApplicationLoadBalancedFargateService`) | High but opinionated. Best for repeatable patterns; can hide important details. |

This project uses primarily L2 (`Stream`, `Table`, `NodejsFunction`,
`StateMachine`) with L1 fallback for IoT (`CfnTopicRule`) and Firehose
(`CfnDeliveryStream`) where the L2 isn't yet production-ready.

---

## The pattern in this project — concrete examples

The table below maps every notable CDK feature this project uses to
the corresponding typed-model property it expresses.

| What | Where it lives | What it ties together |
|---|---|---|
| `SensorEvent` interface | `src/lib/types.ts` | The Zod-validated wire payload, function signatures of `processRecord` / `evaluateThreshold` / `repository.putReading`, the JSON written to DynamoDB, the JSON consumed by the alert handler |
| Filesystem reference to handler | `infra/lib/processing-stack.ts:` `entry: path.resolve(__dirname, '../../src/handlers/processor.ts')` | CDK literally points at application source; one rename, the bundler picks up everything |
| Cross-stack typed contract | `IotStackProps.alertStateMachine?: sfn.IStateMachine` | A constructor prop is a TS interface — pass the wrong type and synth fails |
| Stack outputs as typed instance fields | `AlertWorkflowStack.stateMachine: sfn.IStateMachine` (`public readonly`) | Consumers get a real CDK construct, not a stringified ARN to parse |
| Conditional infra via optional typed prop | `if (props.alertStateMachine && props.alertStateMachineName) { ... }` in `iot-stack.ts` | The configuration knob that turns a feature on or off is an optional TS prop, not a string-keyed feature flag |
| Env vars as typed strings | `environment: { READINGS_TABLE: props.readingsTable.tableName }` | The CDK side passes a typed string; the Lambda side reads a string with a runtime guard. Mismatched key = runtime crash, but the *type* is enforced where it can be |
| Test parity | Jest + ts-jest for both `src/__tests__/` and `infra/__tests__/` | One toolchain, one mental model |
| Bundling integration | `bundling: { externalModules: ['@aws-sdk/*'] }` in `processing-stack.ts` | esbuild config sits in CDK code; reaches into the TS module graph at synth time, knows what's bundled vs runtime |
| IAM grants as typed methods | `props.readingsTable.grantWriteData(processor)` | The grant API is method-typed; you can't `grantWrite` on a Stream by accident |

---

## What this concretely buys you

### No "config strings as text" bugs

When `processing-stack.ts` writes:

```ts
environment: {
  READINGS_TABLE: props.readingsTable.tableName,
}
```

both `READINGS_TABLE` and `tableName` are TypeScript strings the
compiler knows about. Compare to Terraform passing
`var.readings_table_name` to a Lambda environment block — that
connection is made by string matching across HCL files. CDK closes
that gap.

### Refactor amplification

Rename `validateSensorEvent` to `parseSensorEvent` in
`src/lib/validator.ts`. Your IDE follows the symbol into:

- `src/handlers/processor.ts` (where it's called per-record)
- `src/handlers/alert-handler.ts` (where it's called for threshold annotation)
- `src/__tests__/validator.test.ts` (the unit tests)
- Any consumer in CDK that imports types via a shared module

Same toolchain, same type-aware refactor. In a Terraform-managed
Python Lambda monorepo, you'd be doing string find-replace across
files in different languages.

### Single-language code reviews

Reviewers don't context-switch between TypeScript app code and
HCL/YAML infra code. The lib/handler/CDK distinction is purely
*architectural*, not technological.

### Type-level invariants spanning runtime and infra

`kinesis.IStream` isn't just a string ARN — it's a type that exposes
`.streamArn`, `.streamName`, `.grantRead()`. The compiler stops you
from `grantWrite()`-ing on something that's actually a queue. The
contract is enforced at compile time, not at deploy time.

---

## Where this DOES NOT solve everything

Important — and the project's deploy-lessons logs document several
examples. The typed model is leverage, not magic.

| Limit | Where this project hit it | Why TS can't catch it |
|---|---|---|
| **Predicate duplication across languages** | `lib/threshold.ts` (TS) and the IoT Rules SQL filter in `iot-stack.ts` (string) both encode `frequency < 59.5 OR > 60.5` | Cross-language semantic parity; the SQL is a string from TS's perspective |
| **CFN deploy-time ordering** | The Phase 3 `addToPolicy` race; the explicit `node.addDependency` we had to add | Implicit dependencies between CFN resources whose creation timing matters but which TS doesn't model as a dependency |
| **Runtime config drift** | Env vars set in CDK can be edited in the AWS console post-deploy | Continuous enforcement of the IaC contract at runtime — CDK only re-reconciles on the next deploy |
| **IAM eventual consistency** | Sometimes a freshly created role isn't visible to its consumer service for tens of seconds | Time-bound assertions; CDK assumes IAM is strongly consistent, which it isn't |
| **Service-specific Unicode constraints** | The IAM "no em-dash in description" failure | API-level constraints that aren't expressed in the CFN schema |
| **`grant*` action coverage gaps** | `Stream.grantRead` not including `kinesis:DescribeStream` (Firehose's older API) | The L2 grant abstraction reflects modern SDK usage, not what every consuming service actually calls |
| **L2 interface property drift** | `IStateMachine.stateMachineName` removed in newer aws-cdk-lib (only on concrete `StateMachine` class) | Interface stability is *not* a CDK guarantee between minor versions |
| **Block comment delimiters in JSDoc** | `*/` inside a backtick-quoted path inside a JSDoc comment terminated the comment early | Parser-level constraints below the type system |

These aren't refutations — they're the boundary of the abstraction.
The discipline is **single typed model where TS can express it;
explicit prose, contract test, decision-log entry, or code-generation
where it can't.**

---

## The deeper concept (the version you'd say in an interview)

> "Infrastructure as code in the same language as the application is
> one specific instance of a more general pattern: **codify invariants
> at the highest level the language can express them**. CDK puts stack
> composition at the type level — constructor props, typed `readonly`
> fields, interface inheritance. The compiler enforces what would
> otherwise be runtime errors. Pulumi has the same property. Terraform
> and CloudFormation are configuration languages — invariants only
> show up at the JSON Schema level, not at the symbol level."

That framing also tells you when *not* to reach for CDK:

| Situation | Recommendation |
|---|---|
| A team that doesn't write TypeScript or Python anywhere | Use Terraform; the cognitive cost of learning a new language for infra outweighs the typing benefit |
| Multi-cloud or hybrid (AWS + GCP, or AWS + on-prem) | CDK is single-cloud; reach for Pulumi or Terraform with broader provider ecosystems |
| Ops team owns infra independently of app teams | The "single language" benefit only matters when one team owns both. CDK becomes friction across an ops/app handoff |
| Team that prefers HCL's declarative ergonomics over imperative code | Terraform's "describe the desired state" model resonates more with some operators |

CDK is the right answer when:
- One team owns app + infra
- Single-cloud (AWS) is fine
- TypeScript or Python is already in the stack
- Cross-stack composition is non-trivial (multiple stacks, shared resources)

---

## Patterns this project specifically demonstrates

Useful interview talking points anchored in real code:

### 1. Cross-stack composition via typed constructor props (not stringly-typed CFN exports)

```ts
// infra/bin/app.ts
const alertWorkflow = new AlertWorkflowStack(app, '...', { ... });

new IotStack(app, '...', {
  // ...
  alertStateMachine: alertWorkflow.stateMachine,
  alertStateMachineName: alertWorkflow.stateMachineName,
});
```

The IotStack's prop type is `sfn.IStateMachine` — pass a Lambda
instead and the compiler refuses to synth. CDK auto-generates the
CFN exports/imports under the hood, but the *developer* sees a typed
prop, not a stringly-typed cross-stack lookup.

### 2. Conditional infrastructure based on optional typed props

```ts
// infra/lib/iot-stack.ts
if (props.alertStateMachine && props.alertStateMachineName) {
  // Add ThresholdAlertRule + StepFunctionsStart inline policy
}
```

The "should this rule exist?" question is encoded as an optional TS
property. Phase 4 deploys with the prop unset (only AllTelemetryRule).
Phase 5 sets it (adds ThresholdAlertRule). Same stack class, two valid
configurations, type-checked.

### 3. Environment variables as typed contracts

```ts
// CDK side (infra/lib/processing-stack.ts)
environment: {
  READINGS_TABLE: props.readingsTable.tableName,
  IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
}

// Runtime side (src/handlers/processor.ts)
const READINGS_TABLE = process.env.READINGS_TABLE ?? '';
if (!READINGS_TABLE) {
  throw new Error('READINGS_TABLE env var is required');
}
```

The CDK side passes a typed string. The runtime side reads a string
with a guard that throws on missing. The contract isn't TS-enforced
end-to-end (env vars are stringly typed at the runtime boundary), but
the *key name* is a TS literal in both places, and the runtime guard
is explicit.

### 4. CDK template assertions as integration tests

```ts
// infra/__tests__/processing-stack.test.ts
template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
  BisectBatchOnFunctionError: true,
  FunctionResponseTypes: Match.arrayWith(['ReportBatchItemFailures']),
});
```

The architectural invariant ("CLAUDE.md hard rule #9: bisectOnError
must be true on the Kinesis ESM") is locked at synth time. A future
refactor that flips this flag fails the test before it ever reaches a
deploy.

---

## Comparison context

| Tool | Language | Typed-model property | Multi-cloud | Best for |
|---|---|---|---|---|
| **AWS CDK** | TS / Python / Java / Go / .NET | Strong (TS/Python) | No (AWS only) | AWS-native, app+infra in one team |
| **Pulumi** | TS / Python / Java / Go / .NET | Strong | Yes | Multi-cloud with typed-model benefit |
| **CDK for Terraform (CDKTF)** | TS / Python / Java / Go / .NET | Strong | Yes (Terraform providers) | Wanting CDK ergonomics over Terraform's provider ecosystem |
| **Terraform** | HCL | Schema only | Yes | Ops-owned infra, declarative ergonomics |
| **CloudFormation** | YAML / JSON | Schema only | No (AWS only) | Lowest-common-denominator for AWS, when you can't add tooling |

The interesting choice in 2024+ is CDK vs Pulumi vs CDKTF. All three
share the typed-model property; the differentiator is provider scope
(CDK = AWS, Pulumi = anywhere, CDKTF = anywhere via Terraform).

---

## Pitfalls

1. **L1 escape hatches lose the typed model.** When you reach for
   `CfnTopicRule`, you're back to JSON-shape props. Use sparingly;
   when you must, document why and watch for L2 to catch up.

2. **Construct property drift between minor CDK versions.** This
   project hit it: `IStateMachine.stateMachineName` was removed in
   ~v2.150. Pin a known-good `aws-cdk-lib` version range in
   `package.json` and audit on upgrades.

3. **Treating CDK like a static config language.** CDK is *code*. It
   runs at synth time. Branching, loops, conditionals, helper
   functions all work. Don't replicate CFN templates by hand;
   write helpers.

4. **Over-engineering with custom L3 constructs too early.** L3
   patterns are great when you've shipped the same pattern three
   times; premature abstraction creates maintenance burden.

5. **Bundling pitfalls with native dependencies.** Some npm packages
   ship native binaries (e.g., `bcrypt`); esbuild can't bundle them
   for Lambda. Mark them as `externalModules` and add Lambda layers
   for the native bits.

---

## Cost lens

CDK itself is free. Indirect cost considerations:

- **Synthesis time scales with stack count.** Large monorepos with
  100+ stacks see synth times in the minutes. Mitigate by splitting
  into multiple CDK apps when possible.
- **CFN deploy times vs Terraform.** Terraform plans are usually
  faster than CDK synths because Terraform doesn't compile a TS
  program first. For dev iteration, this matters; for prod deploy,
  the difference is washed out.
- **Vendor lock-in cost.** CDK is AWS-native. Migrating to another
  cloud later means rewriting the infra layer. Pulumi or CDKTF
  trade some AWS-specific ergonomics for multi-cloud portability.

---

## Project anchors

When you want to point at this pattern in the codebase:

- **Symbol-flow example** — `SensorEvent` traced from
  `src/lib/types.ts` through `src/lib/validator.ts`,
  `src/handlers/processor.ts`, `src/lib/repository.ts`, and into the
  DynamoDB table key shape defined in `infra/lib/storage-stack.ts`.
- **Cross-stack typed contract** —
  `infra/lib/alert-workflow-stack.ts` exposes `stateMachine` and
  `stateMachineName`; `infra/lib/iot-stack.ts` consumes both via
  `IotStackProps`; `infra/bin/app.ts` wires them together.
- **Conditional infra via optional prop** —
  `infra/lib/iot-stack.ts:` the `if (props.alertStateMachine && props.alertStateMachineName)` block.
- **Template assertions locking invariants** —
  `infra/__tests__/processing-stack.test.ts:` the `BisectBatchOnFunctionError: true` assertion locking CLAUDE.md hard rule #9.
- **Bundling integration with the app code** —
  `infra/lib/processing-stack.ts:` the `entry: path.resolve(...)` and `bundling: { externalModules: ['@aws-sdk/*'] }`.
- **Decision logs for typed-model lessons** —
  `docs/decisions/phase-03-storage-processing.md` (deploy lessons),
  `docs/decisions/phase-05-alert-workflow.md` (cross-stack via prop).

---

## When to revisit this note

- **Before any "why CDK over Terraform?" interview question.** Don't
  give a "I prefer code" answer; give a typed-model answer.
- **When designing a multi-stack composition.** The cross-stack-via-
  constructor-props pattern in `app.ts` is the pattern to lean on.
- **When debugging cross-stack reference issues.** The pattern usually
  means a CFN export/import generated by CDK; check synth output.
- **When evaluating IaC choice for a new project.** The "when *not* to
  reach for CDK" table at the top of this note is the decision tree.
- **When onboarding a new engineer.** This note plus the project's
  decision logs explain the *why* behind every architectural choice
  faster than reading the CDK code.

---

## Did I actually learn this? — self-test

Without looking back at this note, can you:

1. **State CDK's defining property vs Terraform/CloudFormation in one
   breath.** Bonus: what's the underlying *general* pattern this is a
   specific instance of?
2. **Name three concrete things the typed model buys you** in this
   project. Each should be a property the type system enforces that
   would be a runtime error in a config-language IaC tool.
3. **Name three limits of the typed model** — places where the
   abstraction stops helping and you have to reach for explicit
   prose, contract tests, or code generation.
4. **Explain the difference between L1, L2, and L3 constructs.**
   When is reaching for an L1 escape hatch the right call?
5. **Cite three situations where you'd NOT reach for CDK.** What's
   the alternative for each?
6. **Walk through how a constructor prop becomes a CFN
   export/import** at synth time. Why does the developer never see
   the string-typed reference?
7. **Explain why "interface stability is not a CDK guarantee"** —
   give the specific example from this project where we hit it and
   how we recovered.

If 1 trips you up, that's the question to drill — it's the
interview-pivotal one. The pattern *"codify invariants at the highest
level the language can express them"* is the durable concept that
generalizes beyond CDK to any typed-model abstraction (TypeScript
itself, type-safe ORMs, schema-typed APIs, etc.).

If 7 trips you up, reread the pitfalls table — the L2 interface
property drift is the most subtle and unexpected limit of the typed
model, and it's the one most likely to bite you on a CDK upgrade.

---

## Learning resources

### Books
- **Matt Coulter, *AWS CDK in Action*** — practical, covers L3
  patterns and operational considerations.
- **Kief Morris, *Infrastructure as Code* (3rd ed.)** — broader IaC
  context. Doesn't focus on CDK but explains the patterns CDK
  inherits and why they matter.

### Workshops and tutorials
- **AWS CDK Workshop** — https://cdkworkshop.com/ — official, runs
  in TS or Python, well-paced.
- **CDK Patterns** — https://cdkpatterns.com/ — Matt Coulter's
  collection of L3 construct patterns. Excellent for "I want to do
  X; show me a known-good pattern."

### Reference docs
- **AWS CDK API Reference** — the canonical L2 reference, organized
  by service.
- **CDK Construct Hub** — https://constructs.dev/ — community L3
  constructs, with maturity ratings.

### Comparison reads
- **Pulumi docs** — https://www.pulumi.com/docs/ — start with the
  TS examples to feel the typed-model parallel.
- **CDK for Terraform docs** — https://developer.hashicorp.com/terraform/cdktf — when "CDK ergonomics over Terraform providers"
  matters more than AWS-native depth.
- **"CDK vs Terraform" comparisons** — search engineering blogs;
  most are partisan but the cross-cutting points are consistent.

### Conceptual depth
- **Joe Duffy's Pulumi blog** — Pulumi's CTO writes thoughtfully on
  why typed IaC matters and where it's headed.
- **AWS re:Invent talks** — search YouTube for *"AWS CDK Best
  Practices"*. The 2022 and 2023 versions both cover L3 patterns and
  the "constructs as architectural primitives" framing.
- **"Designing for the Type System" (general TS)** — search for
  conference talks on advanced TS patterns; many translate directly
  to CDK construct design.
