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

  Prose placeholders marked [ FILL IN ] — your voice, written in the same
  tone as the existing Roadmap Tracker card. Two paragraphs total.
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
      {/* [ FILL IN — first paragraph, ~2-3 sentences.
          Recommended angle: WHAT it is at architectural shape level, NOT a
          feature list. Example direction:
          "Serverless IoT event-processing pipeline built end-to-end in
          TypeScript — application code, AWS infrastructure (CDK), and an
          MCP server exposing read-only data tools to LLM agents. Sensor
          telemetry flows through IoT Core into a Kinesis-backed
          persistence path and, in parallel, through a Step Functions
          workflow that uses Bedrock to enrich alert notifications with
          LLM-classified severity, routing decisions, and per-channel
          narratives." ]
       */}
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
      {/* [ FILL IN — second paragraph, ~2-3 sentences naming the most
          interesting architectural decisions. Example direction:
          "Architecturally interesting: hybrid Step Functions + LangGraph
          composition (durable workflow at one layer, agentic decisioning
          at another), fail-soft Bedrock fallback (AI-generated content
          is best-effort, never load-bearing), and cost guardrails at
          three time horizons (per-call retry cap + per-window aggregate
          alarm + per-output schema bounds). Production-grade discipline
          in a portfolio POC — decision logs, architectural invariants,
          recurring-failure documentation, end-to-end live verification." ]
       */}
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
    </div>
  </div>
</a>
