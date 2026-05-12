# Portfolio Integration Kit — Grid Sensor Pipeline

> **Standing reference** for integrating this project into
> [amusto.github.io](https://github.com/amusto/amusto.github.io).
> Anyone (or any future Claude session) reading this directory should
> be able to follow the steps below and ship the integration without
> additional context.

---

## What's in this directory

| File | Purpose |
|---|---|
| `card.jsx` | The React JSX snippet to paste into amusto.github.io's `src/App.jsx`. Includes prose placeholders to fill in. |
| `screenshot.svg` | The 400px-wide architecture diagram, used as the card's hero image. |
| `README.md` | This file — integration instructions. |

---

## Integration procedure

### 1. Copy the screenshot asset

From the Grid-Sensor-Pipeline repo, copy:

```
docs/portfolio/screenshot.svg
```

into amusto.github.io at:

```
src/assets/grid-sensor-architecture.svg
```

### 2. Add the import to App.jsx

Near the top of `amusto.github.io/src/App.jsx`, alongside the existing
`roadmapScreenshot` import, add:

```jsx
import gridSensorScreenshot from './assets/grid-sensor-architecture.svg';
```

### 3. Paste the card JSX into App.jsx

Open `amusto.github.io/src/App.jsx`. Find the projects section:

```jsx
{/*PROJECTS*/}
<section id="projects">
  <div className="inner">
    ...
    <div className="proj-grid">
      ...
```

The Grid Sensor Pipeline card replaces the current top hero (Development
Roadmap Tracker) per the positioning decision recorded in
[`../../docs/_private/collaboration-mode.md`](../../docs/_private/collaboration-mode.md) and
related notes. Copy the JSX from `card.jsx` (this directory) — strip the
opening `{/* ... */}` doc comment block — and paste it as the first
child of `<div className="proj-grid">`.

The previous hero (Roadmap Tracker) drops to a regular project card
below, or wherever you want it.

### 4. Rewrite the two prose paragraphs in your voice

The `card.jsx` snippet ships with initial example prose for both
paragraphs — enough to render coherently if you paste and deploy
without changes, but it should be **overwritten in your own voice**
before the card is left live for long. Keep both paragraphs short —
2-3 sentences each.

This is the *knowledge-anchor* step. Don't have Claude rewrite these
for you wholesale. The voice should match the existing Roadmap Tracker
card's cadence.

### 5. Test locally

From `amusto.github.io/` root:

```bash
npm start
```

Visit `http://localhost:3000` and verify:

- Grid Sensor Pipeline appears as the top hero card.
- Architecture diagram renders correctly.
- Stack chips are present.
- Click on the card opens the GitHub diagrams entry point.

### 6. Deploy

```bash
npm run deploy
```

This runs the `gh-pages -d build` pipeline that publishes to your live
amusto.github.io site. ~30-60 seconds. The card is live shortly after.

### 7. Commit the project repo too

Back in `Grid-Sensor-Pipeline`, commit the `docs/portfolio/` directory:

```bash
cd /Users/armandomusto/myWorkplace/portfolio-projects/Grid-Sensor-Pipeline
git add docs/portfolio docs/diagrams
git commit -m "docs: portfolio kit + architecture diagrams"
git push
```

That way the project repo carries its own portfolio kit forever —
future integrations or updates just re-run this procedure against
this directory.

---

## Updating the card later

When the project ships new capabilities (e.g., Phase 9, Phase 10
features), update:

1. **`card.jsx`** in this directory — refresh the prose, refresh the
   stack chips if new technologies were added.
2. **`screenshot.svg`** in this directory — if the architecture
   diagram changes.
3. Re-run steps 1-6 above.

The integration target (amusto.github.io) is downstream of this
directory — keep this directory as the source of truth.

---

## Link target rationale

The card currently points at:

```
https://github.com/amusto/Grid-Sensor-Pipeline/blob/main/docs/diagrams/system-overview.md
```

This is the architecture entry point in the project repo's diagrams
set. Mermaid renders natively on GitHub, and the diagram's node click
directives navigate the reviewer through the drill-down files.

When Phase 2 of the portfolio work ships (the interactive in-page
architecture explorer on amusto.github.io itself), the link target
moves to that internal route (e.g., `/projects/grid-sensor-pipeline`).
Update `card.jsx`'s `href` at that point.

---

## Cross-references

- Architecture diagrams: [`../diagrams/`](../diagrams/) — the linked
  destinations.
- Decision logs: [`../decisions/`](../decisions/) — the trade-offs
  behind every architectural choice.
- Standing collaboration mode: [`../_private/collaboration-mode.md`](../_private/collaboration-mode.md)
  — explains the knowledge-anchor framing for the prose paragraphs.
