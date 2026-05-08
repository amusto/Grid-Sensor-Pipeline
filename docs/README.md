# Project Documentation

Living docs for the grid-sensor-pipeline build. Updated at the end of each
day's work in step with the 9-day build plan in the project root.

## Folder layout

| Path | Purpose | Audience |
|---|---|---|
| `review-checklist.md` | Running tracker — what's implemented, what still needs review, what's a known tech-debt item. One section per day. | Self-review before each milestone. |
| `decisions/day-NN-*.md` | Per-day rationale. For every non-trivial choice: the alternative considered and why this option won. | Interview prep, future-self, code reviewers. |
| `_private/` | Personal interview-prep notes. **Gitignored** — keep cheat-sheets, anticipated panel questions, raw drafts here. | You only. |

## Cadence

At the end of each day's work:

1. Update `review-checklist.md` — flip implemented items to `[x]`, add new open
   review items under that day's section.
2. Create `decisions/day-NN-<short-name>.md` covering every meaningful call.
   Each entry: **decision · alternatives considered · why this won · knowingly
   accepted tradeoffs**.
3. Append a short Day-N section to `_private/interview-prep.md` with
   anticipated questions and crisp answers.

## Before sharing the repo publicly

Run through this once:

- [ ] `_private/` is gitignored (verify in `.gitignore`).
- [ ] No JD, recruiter notes, or portfolio drafts in tracked files.
- [ ] Decision logs read as engineering rationale, not as personal notes.
- [ ] If you want to scrub history (vs. squash to a fresh repo at share time),
      use `git filter-repo` and force-push.
