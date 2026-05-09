# Operations

Runbooks and verification procedures for working with the deployed
pipeline. These are the commands you'll actually run when iterating
locally or debugging an issue.

## What's here

| Doc | When to use |
|---|---|
| [`verification-cheatsheet.md`](verification-cheatsheet.md) | Any time you want to verify "is the pipeline alive?", "did the simulation flow through?", or "where in the pipeline did data stop?" |
| [`recommended-tooling.md`](recommended-tooling.md) | When choosing or revisiting terminal / CLI / IDE tooling for this project's workflow patterns. Compares Warp / Ghostty / iTerm2-with-additions; lists companion tools (`atuin`, `aws-vault`, `fzf`, `starship`, `jq`, etc.). |

## What's NOT here (and where to find it)

- **Architectural rationale** — `docs/decisions/`
- **Conceptual material on AWS services** — `docs/learning/`
- **Project planning + status** — `ROADMAP.md`
- **Interview prep + talking points** — `docs/_private/`

The split is **operations vs design**. This folder answers *"how do I
actually run / verify / debug this thing?"* — not *"why does it look
the way it does?"*.

## Convention

Every operations doc follows the same shape:

1. **Mental model** — what this doc is for, in one paragraph.
2. **Tiers / layers** — commands organized from quickest to most
   forensic.
3. **Suggested workflow** — the minimal loop for the most common
   question.
4. **What to watch when something seems off** — symptom-organized
   debugging guidance.
5. **Maintenance section** — what triggers an update to this doc.
6. **Self-test** — the same "Did I actually learn this?" gate as
   `docs/learning/`.

## Maintenance

When a new phase introduces:
- **A new Lambda** — add a log-tail command to the verification cheatsheet's Tier 2.
- **A new persistent resource (table, queue, stream)** — add inspection commands to the appropriate tier.
- **A new metric** — note the dashboard widget that consumes it.
- **A new alarm** — note its expected steady-state value and how to verify it triggers.

The convention is to update operations docs *in the same commit* as
the phase implementation, not as a follow-up.
