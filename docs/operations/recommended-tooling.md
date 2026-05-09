# Recommended Tooling

> **Status: living doc** — updated as the project's operational
> workflow evolves. Last updated: Phase 6.

> **When to use this.** Decision support for terminal/IDE/CLI tooling
> choices specifically tuned to this POC's workflow patterns:
> long-running CDK deploys, multi-Lambda log tailing, AWS CLI calls,
> and iterative `npm run` cycles.

---

## Mental model

Tooling choice for this project comes down to one question: **what
operations do you do dozens of times per day, and how much friction
does each one carry?**

For this POC specifically, the high-frequency operations are:

| Operation | Frequency per dev session | Friction-prone parts |
|---|---|---|
| `npm run synth` / `npm run deploy` | 5-15× | Long output, hunting for the IAM approval prompt or the failing stack |
| `aws logs tail ...` (multiple Lambdas) | 10-30× | Filter pattern syntax (especially Powertools JSON), tab-juggling for multi-Lambda views |
| `aws dynamodb query/scan` | 5-15× | Long arg lists, JSON expression-attribute-values |
| `npm run simulate -- --count N` | 10-20× | Trivial, but you'll do it a lot |
| `cdk diff` review | 5× | Lots of output to scroll through |
| Reading a deployed stack's outputs | 5× | Repetitive `aws cloudformation describe-stacks ...` invocations |

Pick the terminal/tool stack that minimizes friction on the
*high-frequency* operations. The right answer depends on whether you
prefer modernization (more features, learn-the-paradigm) or
optimization (fewer features, master-what-you-have).

---

## Three primary options

### Warp — modern paradigm shift

The terminal designed around the observation that *commands and their
outputs are structured units, not a stream of text.*

**Block-based output** is the headline feature: each command + its
output is a single navigable "block" you can collapse, expand, link
to, or copy. Specifically valuable for this project:

- After a 5-minute `cdk deploy`, scrolling to the IAM approval prompt
  block or the per-stack output block is one click instead of arrow-
  key purgatory.
- The `cdk diff` output for a multi-stack change becomes manageable —
  each stack's diff is a separate block.
- A failed `npm run deploy` has the failure block (with the CFN
  rollback context) immediately findable.

**AI command suggestions** are a real productivity win for AWS CLI:

- *"tail logs for the alert handler from the last 15 minutes filtering
  for errors"* → Warp suggests the correct `aws logs tail
  /aws/lambda/grid-sensor-pipeline-alert-handler --since 15m
  --filter-pattern '{ $.level = "ERROR" }'`
- *"count rows in the readings table for sensor-001"* → suggests the
  full `aws dynamodb query` invocation with the right key-condition
  expression and expression-attribute-values JSON.

The Powertools JSON filter pattern syntax (the gotcha we hit when
searching `"Alert notified"`) is exactly the kind of thing AI
suggestions get right consistently.

**Saved workflows** map directly to the verification commands we
codified in `verification-cheatsheet.md`. One-keystroke replay of
"ten-second sanity check" or "trigger breach + watch logs":

```yaml
# Example Warp workflow for the breach smoke test
name: "Smoke test: breach mode"
command: |
  npm run simulate -- --count 5 --breach
  sleep 5
  ARN=$(aws cloudformation describe-stacks \
    --stack-name GridSensorAlertWorkflowStack \
    --query "Stacks[0].Outputs[?OutputKey=='AlertWorkflowArn'].OutputValue" \
    --output text)
  aws stepfunctions list-executions \
    --state-machine-arn $ARN --max-results 10 \
    --query "executions[*].[name, status, startDate]" --output table
```

**Other features that matter:**

- **Multi-pane with shared session state** — split panes share env
  vars and cwd by default. Useful for running `npm run simulate` in
  one pane while tailing the processor's logs in another.
- **Cmd+P command palette** — fuzzy-search history across all
  sessions, including ones from previous days.
- **Native macOS** — not Electron. Performs as well as iTerm2 on big
  log dumps.

**Tradeoffs:**

- Block paradigm takes ~30 minutes to internalize. Some shell habits
  (especially complex pipes built incrementally) feel awkward at
  first.
- Some traditional shell integrations (zsh-autosuggestions, custom
  prompts via Powerline/Starship) have Warp-specific equivalents but
  may need re-config.
- AI features default to sending prompts to Warp's servers. Free
  individual plan; enterprise plan adds local-only mode if needed.
- Free for individual use; team features behind a paid plan but not
  needed for solo work.

**Install:** `brew install --cask warp` or download from
https://warp.dev.

---

### Ghostty — fastest traditional terminal

The opposite of Warp: a terminal that doubles down on the traditional
paradigm and optimizes pure speed.

**What it's good at:**

- **GPU-accelerated rendering** — noticeably snappier than iTerm2 on
  big log dumps. Tailing 1000+ records of CloudWatch logs feels
  smooth.
- **Native macOS** — not Electron. Memory footprint and CPU usage are
  minimal.
- **Sane defaults** — works well out of the box; minimal configuration
  needed to feel productive.
- **Simple config** — plain text file, well-documented options, no
  scripting language to learn.

**What it doesn't have:**

- No AI command suggestions
- No block-based output
- No saved workflows
- No paradigm shift — it's a faster, cleaner version of what you
  already know

**Pedigree.** Mitchell Hashimoto (founder of HashiCorp; creator of
Vagrant, Packer, Terraform's early prototype) wrote it. Released 1.0
in 2024. Steady adoption among engineers who prefer the traditional
paradigm but want better-than-iTerm2 performance.

**Install:** `brew install --cask ghostty` or download from
https://ghostty.org.

---

### Stay on iTerm2, upgrade your stack

If you'd rather not switch terminals, iTerm2 is genuinely fine — most
of the friction in this POC's workflow comes from tooling *around* the
terminal, not the terminal itself. Four additions that punch above
their weight:

| Tool | What it solves | Install |
|---|---|---|
| **`atuin`** | Better shell history — searchable, syncable across machines, far better than `Ctrl+R` reverse-i-search | `brew install atuin` |
| **`aws-vault`** | Credential management with TTLs, MFA support, multi-account juggling | `brew install --cask aws-vault` |
| **`fzf` shell integration** | Fuzzy file/history search bound to `Ctrl+T` (file) and `Ctrl+R` (history) | `brew install fzf && $(brew --prefix)/opt/fzf/install` |
| **`zsh-autosuggestions` + `zsh-syntax-highlighting`** | Inline command suggestions and live syntax checking — feels like a small upgrade, becomes essential | `brew install zsh-autosuggestions zsh-syntax-highlighting` (then add to `.zshrc`) |

Together these close most of the practical gap with Warp's modern
paradigm — at the cost of more configuration discipline. Worth doing
even if you stay on iTerm2 long-term.

---

## Other tools worth considering

### VS Code / Cursor integrated terminal

For when you want the terminal *inside* the editor rather than
beside it:

- Useful for quick `npm test` / `npm run synth` runs while editing
  CDK code.
- Cursor's AI features extend to terminal commands too; competitive
  with Warp for AWS CLI suggestions.
- Less powerful than a dedicated terminal app for long-running
  processes (deploys, log tails) — the integrated terminal can be
  flaky on tab-switch or window resize.

**Practical pattern:** use the integrated terminal for
*context-bound* work (running tests on the file you just edited) and
a dedicated terminal app (Warp / Ghostty / iTerm2) for
*infrastructure-bound* work (deploys, log tailing, AWS CLI).

### tmux

Session multiplexer. Useful if:
- You SSH into a remote box (this project is local-only, so probably
  not).
- You want session persistence across terminal app restarts (Warp
  has its own session restoration; tmux is the platform-agnostic
  version).
- You want fine-grained pane management beyond what your terminal
  app provides.

For this POC's local-only workflow, tmux is overkill. Worth knowing
exists; not worth setting up unless your workflow grows beyond a
single machine.

---

## Project-specific feature wins

Mapping the high-frequency operations to which option helps most:

| Operation | Best in Warp | Best in Ghostty | Best in iTerm2+stack | Best in IDE terminal |
|---|---|---|---|---|
| Reading long `cdk deploy` output | ✅ Block navigation | — | — | — |
| Constructing AWS CLI commands from memory | ✅ AI suggestions | — | Partial (`atuin` history) | ✅ (Cursor AI) |
| Tailing multiple Lambda logs in parallel | ✅ Multi-pane shared state | ✅ Multi-pane | ✅ Multi-pane | Cramped |
| Running `npm test` while editing | — | — | — | ✅ Integrated |
| Replaying verification commands | ✅ Saved workflows | — | History via `atuin` | History |
| Speed on big log dumps | Equal | ✅ Fastest | Slower | Slowest |
| Working without internet (no AI) | Limited (most features local) | ✅ Pure local | ✅ Pure local | Depends |

---

## Honest recommendation for this project

**Try Warp for a week.** The block-based output is meaningfully better
for `cdk deploy` and multi-stack work, and the AI suggestions for AWS
CLI commands are noticeably valuable when you're juggling unfamiliar
service calls. We've already hit `iot:DescribeEndpoint`, custom
resource lookups, Step Functions ARN extractions, SQS queue URL
references, CloudWatch Logs Insights filter patterns — all exactly
what AI suggestions handle better than memory.

**If after a week the block paradigm doesn't click,** fall back to:

- **Ghostty** for the speed upgrade if you want fast and clean.
- **iTerm2 + the four-tool stack** if you want familiarity with
  significant productivity gains.

**Don't run all three at once.** Pick one as your primary; switching
mid-session adds overhead.

---

## Companion tools (terminal-agnostic)

These work in any terminal and are worth adding regardless of choice:

| Tool | What it does | Project use case |
|---|---|---|
| **`jq`** | JSON parser for the command line | Slicing AWS CLI JSON output to specific fields |
| **`bat`** | `cat` with syntax highlighting and line numbers | Reading config files / decision logs |
| **`exa`** / **`eza`** | `ls` with better defaults (icons, git status, tree mode) | Quick repo navigation |
| **`gh`** | GitHub CLI | Creating PRs, checking issues without leaving the terminal |
| **`starship`** | Cross-shell prompt customization | Visible AWS profile / region indicator in the prompt — prevents *"oh no I deployed to the wrong account"* moments |
| **`direnv`** | Per-directory env vars | Auto-loading project-specific AWS profile / region when you `cd` in |

**`starship` deserves a special call-out for this project specifically.**
A prompt that shows your current AWS profile and region prevents
deploying to the wrong account — a class of mistake that's both easy
to make and expensive to recover from.

```toml
# ~/.config/starship.toml — minimal config showing AWS context
[aws]
format = '[$symbol($profile )(\($region\) )(\[$duration\])]($style)'
style = "bold blue"
symbol = "☁️ "
```

---

## Maintenance

Update this doc when:

- A new tool meaningfully changes the workflow (e.g., a new terminal
  app ships, a CLI tool becomes essential).
- Project workflow patterns change (e.g., we add a feature that needs
  remote dev, making tmux relevant).
- A recommendation goes stale (e.g., Warp's pricing changes, or
  another terminal catches up on features).

Don't add tools just because they're trendy. The bar is *"would I
recommend this to a teammate joining this project?"*. If yes, add it;
if no, don't.

---

## Did I actually learn this? — self-test

Without looking back at this doc, can you:

1. **Name the high-frequency operations** in this POC's workflow.
   What kinds of friction do they carry?
2. **Explain the Warp block paradigm** in one breath. What specific
   POC operation benefits most from it?
3. **State the four iTerm2 companion tools** and what each one solves.
4. **Justify the "stay on iTerm2 + add tools" path** as a defensible
   choice rather than a fallback. When would it actually be the
   better choice?
5. **Cite the case for `starship`'s AWS context indicator** —
   what failure mode does it prevent, and why does that matter for
   this project specifically?
6. **Name when tmux would be the right call for this project** —
   what workflow change would justify it?

If 5 trips you up, reread the "Companion tools" section. The "deploy
to the wrong account" failure mode is the single most expensive
mistake in AWS-native development; visible profile/region indicators
are the cheapest insurance against it.
