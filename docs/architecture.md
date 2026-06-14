# FLOCI NEXUS — Architecture

## System overview

FLOCI NEXUS is a four-agent pipeline that turns a plain-English infrastructure request into a running Terraform deployment — with a live Kanban board, per-agent memory, and optional human-in-the-loop approval gates.

```
User (natural language)
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│                     FLOCI NEXUS API  (:3002)                  │
│                                                               │
│  POST /api/orchestrate ──────────────────────────────────┐   │
│                                                           │   │
│  ┌─────────────────────────────────────────────────────┐ │   │
│  │                   Pipeline (8 stages)               │ │   │
│  │                                                     │ │   │
│  │  1. ARIA   — Requirements Intelligence              │ │   │
│  │             natural language → structured JSON      │ │   │
│  │                      ↓                              │ │   │
│  │  2. FORGE  — Terraform Code Generation              │ │   │
│  │             requirements → HCL + self-correction    │ │   │
│  │                      ↓                              │ │   │
│  │  3. Admin gate (plan approval)                      │ │   │
│  │                      ↓                              │ │   │
│  │  4. terraform plan                                  │ │   │
│  │                      ↓                              │ │   │
│  │  5. Admin gate (apply approval)                     │ │   │
│  │                      ↓                              │ │   │
│  │  6. terraform apply                                 │ │   │
│  │                      ↓                              │ │   │
│  │  7. SAGE   — Validation                             │ │   │
│  │             deployed state vs original requirements │ │   │
│  │                      ↓                              │ │   │
│  │  8. SCOUT  — Capability Gap Detection               │ │   │
│  │             flags unsupported services              │ │   │
│  └─────────────────────────────────────────────────────┘ │   │
│                                                           │   │
│  SSE /api/stream  ←── real-time Kanban + chat events     │   │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
   PostgreSQL 14
   + pgvector 0.8
```

---

## Agents

### ARIA — Adaptive Requirements Intelligence Agent
**Model:** `llama-3.1-8b-instant` (Groq)  
**Memory type:** Episodic — stores every conversation as a specific experience.

Parses the user's natural language request into a structured JSON object:
```json
{
  "services": ["S3", "Lambda", "API Gateway"],
  "compute": { "runtime": "nodejs18.x", "memory": 512 },
  "storage": { "versioning": true },
  "raw_summary": "Serverless blog backend with file storage"
}
```

Before generating, ARIA recalls similar past requests from its episodic memory. After parsing, it stores the experience so future similar requests benefit from the recall.

---

### FORGE — Foundational Operations Resource and Generation Engine
**Model:** `llama-3.3-70b-versatile` (Groq)  
**Memory type:** Procedural — stores proven Terraform patterns as skills.

Generates HCL Terraform from structured requirements. Key design decisions:

**Reference template approach:** Instead of rule-listing, FORGE's system prompt includes a complete working HCL example (random_id + archive_file + IAM + Lambda + API Gateway). The model adapts this rather than generating from scratch, reducing hallucinated resource names and incorrect integration types.

**Self-correction loop:** After generating code, the orchestrator runs `terraform plan`. On failure, the stderr is fed back to FORGE which rewrites the code. Up to 3 attempts per pipeline run.

**Mandatory invariants baked into the prompt:**
- All resource names include `-${random_id.suffix.hex}` to prevent name conflicts between runs
- Lambda zips use `archive_file` data source with inline source (no external file references)
- API Gateway Lambda integration type is always `AWS_PROXY`
- Provider, terraform, and variable blocks are omitted (injected by `TerraformExecutor`)

---

### SAGE — Systematic Architecture Governance Engine
**Model:** `llama-3.1-8b-instant` (Groq)  
**Memory type:** Semantic — accumulates validation rules and observed outcomes as facts.

Receives the deployed Terraform state and original requirements and returns:
```json
{
  "passed": true,
  "issues": [],
  "warnings": ["IAM role uses broad policy — consider least-privilege"],
  "summary": "All 5 resources deployed and match requirements."
}
```

Stores every validation outcome as a semantic fact, building an ever-growing body of knowledge about what deployments succeed and why.

---

### SCOUT — Service Capability Observer and Uncharted Territory Tracker
**Model:** `llama-3.1-8b-instant` (Groq)  
**Memory type:** Mixed (episodic + semantic) — records discoveries at the frontier.

Compares the user's requirements against what Floci actually supports. Known unavailable services: RDS, ElastiCache, Kubernetes, CloudFront, WAF, Kinesis, Step Functions.

Every detected gap is:
1. Stored as an episodic memory ("user requested X — not available")
2. Written to the `capability_gaps` table (with deduplication and occurrence counting)
3. Broadcast via SSE to the Kanban board

---

## Memory system (AgentBrain)

Each agent has its own `AgentBrain` instance backed by three PostgreSQL tables.

### Memory types

| Type | Table | What it stores | Decay rate |
|---|---|---|---|
| Episodic | `episodic_memories` | Specific past experiences (conversations, deployments, gaps) | ~13%/day |
| Semantic | `semantic_memories` | Facts and rules (Terraform rules, Floci capabilities, validation outcomes) | ~2%/day |
| Procedural | `procedural_memories` | Skills and patterns (HCL templates, step-by-step recipes) | ~8%/day |

### Ebbinghaus decay

Strength decays continuously using an exponential formula inspired by Ebbinghaus's forgetting curve:

```
new_strength = max(0, strength × rate^(hours_since_last_access))
```

Decay rates per type (hourly):
- Episodic: 0.985 — vivid experiences fade quickly
- Semantic: 0.998 — domain knowledge persists
- Procedural: 0.992 — skills need regular use

When a memory is retrieved its strength is boosted (episodic +0.12, semantic +0.05, procedural +0.18). Memories below 0.07 strength are considered archived and excluded from retrieval.

A background loop in `api.ts` runs decay every 60 seconds across all agents.

### Vector retrieval (pgvector)

Every memory is embedded with **Ollama `nomic-embed-text`** (768 dimensions, runs locally, free). Embeddings are stored in `vector(768)` columns.

At query time, the query text is also embedded and cosine similarity is used to find the most relevant memories:

```sql
SELECT * FROM episodic_memories
WHERE agent_name = $1 AND strength > 0.07 AND embedding IS NOT NULL
ORDER BY embedding <=> $query_vec::vector
LIMIT 3;
```

**Fallback:** If Ollama is unavailable, the system falls back to Jaccard keyword similarity automatically. No manual intervention needed.

**Backfill:** On server startup, any existing memories that lack embeddings are backfilled automatically. A `POST /api/admin/backfill-embeddings` endpoint allows manual re-runs.

---

## Terraform execution

Each pipeline run gets an isolated working directory:

```
/tmp/terraform/{userId}/{runId}/
├── main.tf        ← FORGE-generated HCL
└── providers.tf   ← injected by TerraformExecutor
```

`providers.tf` is always injected (never generated by FORGE) and contains:
- AWS provider with `skip_credentials_validation`, `skip_requesting_account_id`, `skip_metadata_api_check`
- Endpoint overrides mapping all AWS services to LocalStack (`:4566`)
- Variables: `aws_region`, `aws_access_key_id`, `aws_secret_access_key`, `floci_endpoint`, `aws_account_id`

All executions (plan and apply) are logged to `terraform_executions` in PostgreSQL.

---

## Real-time communication (SSE)

All pipeline events are broadcast over a single Server-Sent Events stream at `GET /api/stream`.

Event types:

| Event | Trigger |
|---|---|
| `task_created` | New pipeline run started |
| `task_moved` | Task moved to a new Kanban column |
| `agent_status` | Agent changed state (idle/thinking/working) |
| `chat_message` | Agent sent a message in the task chat |
| `memory_update` | Agent memory stats changed |
| `gap_detected` | SCOUT found an unsupported service |
| `activity` | Human-readable activity log entry |
| `decay_tick` | Background decay loop completed |

The React frontend (`floci-ui`) connects to this stream and renders the live Kanban board.

---

## Data flow diagram

```
POST /api/orchestrate
        │
        ├─► Create kanban_tasks row (column: queued)
        │
        └─► runPipeline() [async, non-blocking to HTTP response]
                │
                ├─[ARIA]─► getMemoryContext(userMessage)
                │           ├── recallEpisodes()  → vector search
                │           ├── queryFacts()      → vector search
                │           └── recallSkills()    → vector search
                │          Groq API call → requirements JSON
                │          storeEpisode() → write + embed
                │          INSERT agent_runs (type=requirements)
                │
                ├─[FORGE]─► getMemoryContext(requirements)
                │           Groq API call → HCL code
                │           encodeSkill() → write + embed
                │           INSERT agent_runs (type=codegen)
                │
                ├─[Wait: admin plan approval]
                │
                ├─[TerraformExecutor]─► terraform plan (up to 3 attempts)
                │   on failure: FORGE.fixTerraform(code, stderr) → retry
                │
                ├─[Wait: admin apply approval]
                │
                ├─[TerraformExecutor]─► terraform apply
                │   INSERT terraform_executions
                │   UPDATE agent_runs.terraform_state
                │
                ├─[SAGE]─► validate(requirements, tfState, applyOutput)
                │           learnFact() → write + embed
                │
                └─[SCOUT]─► detectGaps(requirements, terraformCode)
                            storeEpisode() per gap → write + embed
                            INSERT/UPDATE capability_gaps
```

---

## Directory structure

```
floci-agents/
├── src/
│   ├── agents.ts          — ARIA, FORGE, SAGE, SCOUT classes + SOULS config
│   ├── brain.ts           — AgentBrain (memory read/write, decay, embeddings)
│   ├── orchestrator.ts    — 8-stage pipeline coordination
│   ├── terraform-executor.ts — terraform plan/apply wrapper + provider injection
│   ├── kanban.ts          — KanbanBoard, SSE broadcast, agent status
│   ├── api.ts             — Express HTTP server + all endpoints
│   ├── db.ts              — pg pool + createTerraformExecution()
│   └── public/
│       └── index.html     — standalone Kanban dashboard (no build step)
├── docs/
│   ├── architecture.md    — this file
│   └── api.md             — REST API reference
├── schema.sql             — complete database schema (authoritative)
├── start.sh               — production start script
├── .env.example           — environment template
├── tsconfig.json
└── package.json
```
