# Evaluación: Torus (via Kforce) — Staff Software Engineer (TypeScript)

**Fecha:** 2026-05-06
**URL:** https://ats.rippling.com/torus/jobs/997af05d-d1a7-48fb-b9ec-84a1908efda1
**URL (recruiter brief):** local:jds/kforce-typescript-technical-lead-role.md
**Arquetipo:** Backend Engineer (event-driven/AWS-native) + Full Stack Technical Lead
**Score:** 3.9/5
**Legitimacy:** High Confidence (official JD confirmed on company ATS — Torus, Springville/South Salt Lake UT)
**PDF:** output/cv-armando-musto-kforce-clean-energy-2026-05-06.pdf

---

## A) Resumen del Rol

| Dimension | Detail |
|-----------|--------|
| **Company** | Torus — mesh energy infrastructure; 540K sqft manufacturing facility (GigaOne), Springville/South Salt Lake UT |
| **Recruiter** | Richard Travis, Kforce |
| **Archetype** | Backend Engineer (event-driven/AWS-native) + Full Stack Technical Lead |
| **Domain** | Clean energy / mesh energy infrastructure — resilient community power systems, IoT hardware-cloud integration |
| **Function** | Build + lead (hands-on backend + architecture leadership across firmware, IoT, cloud, data science) |
| **Seniority** | Staff (8+ years required; 3-4+ years staff/principal/architecture) |
| **Remote** | Primarily remote (US-based) — occasional onsite Springville/South Salt Lake UT ⚠️ |
| **Comp** | $150,000–$180,000 base + equity |
| **Team** | Cross-functional: Product, Design, Firmware, Data Science, Manufacturing |
| **ATS** | Rippling |
| **TL;DR** | Staff TypeScript engineer at Torus — architect and build serverless AWS event-driven systems integrating IoT hardware with cloud. TypeScript + AWS Lambda/DynamoDB/IoT Core/Step Functions/CDK. AI/ML integration required (Bedrock, LangChain, LangGraph, MCP). High ownership, startup pace, clean energy mission. |

### Official JD — Full Tech Stack
- **Languages:** TypeScript (primary), React.js
- **AWS:** Lambda, API Gateway, DynamoDB, **IoT Core**, **Step Functions**, **CDK**, Bedrock
- **AI/ML:** AWS Bedrock, LangChain, LangGraph, Model Context Protocol ⚠️ required
- **Observability:** Datadog
- **Infra:** Docker, IaC, CI/CD
- **Patterns:** Serverless, event-driven, microservices, SDK design, RESTful APIs

### Delta from Recruiter Brief → Official JD

| Item | Recruiter said | Official JD | Impact |
|------|---------------|-------------|--------|
| Company | Unnamed | **Torus** (Springville/S. Salt Lake UT) | Legitimacy confirmed ✅ |
| Comp | $175K–$180K max | $150K–$180K range | Floor is $150K — at walk-away threshold |
| Stack | Kafka, ActiveMQ, Redis | Lambda/DynamoDB/IoT Core/Step Functions/CDK | Stronger serverless alignment; no Kafka mention |
| AI/ML | Not mentioned | **Required** (Bedrock, LangChain, LangGraph, MCP) | New gap — address in interview |
| IoT | Mentioned vaguely | **AWS IoT Core** explicitly | Confirms IoT integration; AWS-native |
| CDK | Mentioned as question | **Confirmed in stack** | POC CDK choice was correct ✅ |
| Onsite | Fully remote | Occasional onsite Utah | ⚠️ Flag — outside commute radius |
| Orchestration | Not mentioned | **Step Functions** | New gap — learnable, mention in interview |

## B) Match con CV

| JD Requirement | CV Evidence | Match |
|----------------|-------------|-------|
| TypeScript backend | Core stack; NestJS at Cisco, Node.js/TypeScript at Aireon, uExamS, College Board | ✅ Strong |
| Event-driven architecture | Kafka + AWS Lambdas at Aireon; ActiveMQ at Northstrat; SQS at College Board | ✅ Direct |
| Kafka | Aireon: "event-driven architecture using AWS Lambdas and Kafka" | ✅ Exact |
| ActiveMQ | Northstrat: "publishing and subscribing to message brokers (Kafka and ActiveMQ)" | ✅ Exact |
| AWS (S3, DynamoDB, serverless) | College Board: Lambdas, SQS, S3, DynamoDB; uExamS: serverless AWS architecture | ✅ Exact |
| Redis | Not explicit on CV — adjacent caching/pub-sub patterns | ⚠️ Gap |
| Terraform / Terragrunt | Cisco + uExamS: Terraform in production; Terragrunt adjacent | ✅ / ⚠️ Partial |
| CDK | Not on CV — uses Terraform IaC | ⚠️ Gap — learnable |
| Scaling / distributed systems | Aireon mission-critical streaming; multiple production microservice systems | ✅ Inferred |
| IoT devices | Not on CV | ⚠️ Domain gap — not a hard blocker |
| High ownership / early platform | uExamS: led full platform build; Cisco: greenfield from scratch | ✅ Strong |

**Updated gaps from official JD:**

| Gap | Severity | Mitigation |
|-----|----------|------------|
| AI/ML required (Bedrock, LangChain, LangGraph, MCP) | **Significant** — listed as required, not nice-to-have | "I've integrated LLM APIs at the application layer; AWS Bedrock is the managed wrapper for models I'm already familiar with. LangChain/LangGraph I'd ramp on — the orchestration pattern maps to Step Functions workflows I've built." |
| AWS Step Functions | Moderate | "Event-driven orchestration — same mental model as Lambda chains; CDK construct is straightforward." |
| CDK | Soft | Confirmed as their stack — **POC project uses CDK** ✅ Frame as: "I've been building a grid sensor pipeline with CDK for this exact interview." |
| AWS IoT Core | Soft | Confirmed as their stack — Aireon telemetry ingestion analogy still holds |
| Occasional onsite Utah | Location concern | Outside commute radius — clarify frequency. If quarterly or less, may be acceptable. Flag with Richard. |
| Datadog | Soft | Adjacent to CloudWatch — same observability discipline, different tooling |

## C) Nivel y Estrategia

Staff level is correct (8+ years required; candidate has 20+). Lead with Aireon event-driven pipeline + Cisco greenfield ownership. The official JD confirms this is a direct hire at Torus, not a contract — changes the comp and career conversation significantly.

**Updated questions for Richard / Torus screen:**
1. Is this direct hire at Torus or W2 contract through Kforce? (JD reads like direct hire)
2. How frequent is the onsite requirement in Utah — onboarding only, quarterly, or regular cadence?
3. Where does the AI/ML work fit in the roadmap — is Bedrock/LangChain in active use or a near-term initiative?
4. What does the current serverless architecture look like — is it Lambda + Step Functions today, or greenfield?

## D) Comp y Demanda

| Metric | Data | Source |
|--------|------|--------|
| Staff Backend TypeScript remote | $170K–$250K total comp | HN Jobs / SecondTalent 2026 |
| Senior/Staff AWS backend remote | $150K–$200K base | Arc.dev / Built In 2026 |
| Event-driven architecture premium | +10–20% | Gigson 2026 |
| Kforce staffing markup | 20–35% on top of W2 rate | Standard |
| Offered ceiling | $175K–$180K base W2 | Recruiter |

$180K W2 is low-end market for Staff TypeScript event-driven. C2C at $100–110/hr is the right counteroffer if W2 is firm.

## E) Plan de Personalización

| # | Section | Change | Why |
|---|---------|--------|-----|
| 1 | Summary | Lead with "event-driven architecture" + "AWS-native TypeScript" + "early-stage platform ownership" | 3 JD pillars |
| 2 | Aireon | Specify: Kafka, AWS Lambdas, event-driven pipelines, mission-critical streaming | Exact vocabulary |
| 3 | Northstrat | Specify: Kafka + ActiveMQ patterns, API-First, message broker standardization | Exact match |
| 4 | uExamS | Highlight: AWS serverless (Lambda, API Gateway, DynamoDB, S3), Terraform IaC, event-driven triggers | Full AWS serverless |
| 5 | Skills | Lead cluster: TypeScript · Kafka · ActiveMQ · AWS Lambda · DynamoDB · SQS · S3 · Terraform | ATS alignment |

## F) Plan de Entrevistas

| # | Requirement | Story | Reflection |
|---|-------------|-------|------------|
| 1 | Event-driven at scale | Aireon streaming pipeline (Kafka, Lambda, real-time aircraft data) | Formalize SLOs earlier |
| 2 | Message broker depth | Northstrat ActiveMQ + Kafka standardization | Schema registry from day 1 |
| 3 | AWS serverless + DynamoDB | uExamS ETL (Lambda + DynamoDB + S3 + Rekognition) | Partition key design is critical |
| 4 | Early-stage ownership | Cisco greenfield from scratch | ADRs earlier reduce rework |
| 5 | Terraform/IaC | uExamS + Cisco IaC | Separate modules per env from day 1 |
| 6 | IoT gap mitigation | Aireon telemetry ingestion = same pattern as IoT event streams | Focus on data contract, not hardware |

**Case study:** Aireon streaming pipeline — real-time data from physical infrastructure via event-driven AWS. Direct analogy to grid/IoT data.

## G) Posting Legitimacy

**Assessment: Proceed with Caution** (recruiter-sourced, limited verifiability — not a concern)

| Signal | Finding | Weight |
|--------|---------|--------|
| Active recruiter outreach | Richard Travis, Kforce, reached out directly | ✅ Strong positive |
| Kforce credibility | Established national staffing firm | ✅ Positive |
| Client unnamed | Standard NDA — disclosed at interview | ⚠️ Neutral |
| No public posting | Recruiter-sourced only | ⚠️ Neutral |
| Comp disclosed | $175K–$180K ceiling shared upfront | ✅ Positive |
| Specific domain details | "~20% built," grid stabilization, backup power, IoT | ✅ Positive |
| Interview process shared | 3-round process described | ✅ Positive |

---

## Keywords extraídas

TypeScript, Node.js, event-driven architecture, Kafka, ActiveMQ, AWS Lambda, DynamoDB, S3, Redis, SQS, serverless, Terraform, Terragrunt, CDK, AWS CDK, IoT, scaling, microservices, clean energy, grid infrastructure, backend, Staff Engineer, remote
