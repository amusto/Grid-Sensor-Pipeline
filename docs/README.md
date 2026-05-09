# Project Documentation

Living docs for the grid-sensor-pipeline build. Updated at the end of each
day's work in step with the 9-day build plan in the project root.

## Folder layout

| Path | Purpose | Audience |
|---|---|---|
| `review-checklist.md` | Running tracker — what's implemented, what still needs review, what's a known tech-debt item. One section per phase. | Self-review before each milestone. |
| `decisions/phase-NN-*.md` | Per-phase rationale. For every non-trivial choice: the alternative considered and why this option won. | Interview prep, future-self, code reviewers. |
| `learning/` | Service cheatsheets and conceptual material — Kinesis, IoT Core, Step Functions, CDK-as-typed-model, simulation patterns, the design-patterns review index. Each note ends with a self-test gate. | Background reading, interview prep. |
| `operations/` | Runbooks and verification procedures — *"how do I actually run / verify / debug this thing?"* commands. Updated alongside any phase that adds new resources. | Daily use during development; debugging. |
| `handoff/` | Specs for moving features into other projects (e.g., the Mermaid roadmap export feature spec). | Cross-project handoff. |
| `_private/` | Personal interview-prep notes. **Gitignored** — keep cheat-sheets, anticipated panel questions, raw drafts here. | You only. |

## Cadence

At the end of each phase's work:

1. Update `review-checklist.md` — flip implemented items to `[x]`, add new open
   review items under that phase's section.
2. Create `decisions/phase-NN-<short-name>.md` covering every meaningful call.
   Each entry: **decision · alternatives considered · why this won · knowingly
   accepted tradeoffs**.
3. Update / fill in the relevant `learning/` note(s) with project anchors
   from real implementation. Self-test section is required for a note to
   be considered "filled."
4. Update `operations/verification-cheatsheet.md` with any new Lambdas,
   queues, tables, or alarms introduced.
5. Append a short Phase-N section to `_private/interview-prep.md` with
   anticipated questions and crisp answers.

## Before sharing the repo publicly

Run through this once:

- [ ] `_private/` is gitignored (verify in `.gitignore`).
- [ ] No JD, recruiter notes, or portfolio drafts in tracked files.
- [ ] Decision logs read as engineering rationale, not as personal notes.
- [ ] If you want to scrub history (vs. squash to a fresh repo at share time),
      use `git filter-repo` and force-push.
