{/*
  Grid Sensor Pipeline — Portfolio Card (Hero)
  ============================================
  Paste this card into amusto.github.io/src/App.jsx in the projects section.
  Make it the FIRST card in the grid (replacing the current hero) per the
  positioning decision captured in docs/portfolio/README.md.

  Required imports at the top of App.jsx:
    import gridSensorScreenshot from './assets/grid-sensor-architecture.svg';
  (or .png if you convert the SVG to PNG first — both work as <img src>)

  Required asset:
    Copy docs/portfolio/screenshot.svg from Grid-Sensor-Pipeline into
    amusto.github.io/src/assets/grid-sensor-architecture.svg

  Initial prose is included inline as a starting point. Overwrite both
  paragraphs in your own voice — the existing Roadmap Tracker card's
  cadence is the reference. Two paragraphs total.

  Phase 15 update (2026-06-18): a "Factory Floor Mapping" framing sentence
  was added to the second paragraph and two stack chips ("Asset
  Intelligence", "Indoor Mapping") were added. These additions are
  Claude-drafted and PENDING a voice pass before the card goes live — see
  docs/portfolio/README.md step 4 (the knowledge-anchor step).
*/}

<a
  href="https://github.com/amusto/Grid-Sensor-Pipeline/blob/main/docs/diagrams/system-overview.md"
  className="proj-card hero-proj"
  target="_blank"
  rel="noopener"
>
  <span className="proj-arrow">↗</span>
  <div>
    <p className="proj-type">
      Serverless · TypeScript · AWS · Production-Grade POC
    </p>
    <h3>Grid Sensor Pipeline</h3>
    <p>
      Serverless IoT event-processing pipeline built end-to-end in
      TypeScript — application code, AWS infrastructure (CDK), and an
      MCP server exposing read-only data tools to LLM agents. Sensor
      telemetry flows through IoT Core into a Kinesis-backed
      persistence path and, in parallel, through a Step Functions
      workflow that uses Bedrock to enrich alert notifications with
      LLM-classified severity, routing decisions, and per-channel
      narratives.
    </p>
  </div>
  <div>
    <p
      style={{
        fontSize: '14px',
        color: 'rgba(247,244,239,0.65)',
        lineHeight: '1.72',
        marginBottom: '1.5rem',
      }}
    >
      Architecturally interesting: hybrid Step Functions + LangGraph
      composition (durable workflow at one layer, agentic decisioning
      at another), fail-soft Bedrock fallback (AI-generated content
      is best-effort, never load-bearing), and cost guardrails at
      three time horizons (per-call retry cap + per-window aggregate
      alarm + per-output schema bounds). Production-grade discipline
      in a portfolio POC — decision logs, architectural invariants,
      recurring-failure documentation, end-to-end live verification.
      Phase 15 extends it from telemetry-centric to asset-centric:
      deterministic factory-floor mapping turns sensor alerts into
      location-aware operational incidents tied to real equipment,
      production zones, and response workflows — with the LLM strictly
      summarizing structured location context it's handed, never
      inventing locations.
    </p>
    <div style={{ marginBottom: '1.5rem' }}>
      <img
        src={gridSensorScreenshot}
        alt="Grid Sensor Pipeline Architecture"
        width={'400px'}
      />
    </div>
    <div
      style={{
        height: '1px',
        background: 'rgba(247,244,239,0.12)',
        marginBottom: '1.5rem',
      }}
    ></div>
    <div className="proj-meta-label">Stack</div>
    <div className="proj-chips">
      <span className="proj-chip">TypeScript</span>
      <span className="proj-chip">AWS CDK</span>
      <span className="proj-chip">Step Functions</span>
      <span className="proj-chip">Bedrock</span>
      <span className="proj-chip">LangGraph</span>
      <span className="proj-chip">MCP</span>
      <span className="proj-chip">Asset Intelligence</span>
      <span className="proj-chip">Indoor Mapping</span>
    </div>
  </div>
</a>
