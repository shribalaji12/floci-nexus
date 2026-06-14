# FLOCI NEXUS

A four-agent system that turns a plain-English infrastructure request into a running Terraform deployment — with persistent vector memory, real-time Kanban tracking, and a conversational agent console.

```
"I need a micro-blog website with file uploads and an API"
                          ↓
          ARIA  →  FORGE  →  SAGE  →  SCOUT
          parse    codegen   validate  gaps
                          ↓
              terraform plan + apply
                          ↓
         5 AWS resources live on LocalStack
```

---

## What it does

| Stage | Agent | What happens |
|---|---|---|
| Requirements | **ARIA** | Parses natural language → structured JSON; recalls past similar requests |
| Code generation | **FORGE** | Generates HCL Terraform; self-corrects on plan failure (up to 3 attempts) |
| Validation | **SAGE** | Compares deployed state against requirements; flags mismatches |
| Gap detection | **SCOUT** | Identifies unsupported services; logs gaps for product roadmap |

Every agent has its own **persistent memory** (episodic, semantic, procedural) with Ebbinghaus-style decay and vector similarity retrieval via pgvector. The more the system runs, the better each agent gets at its job.

---

## Tech stack

| Component | Technology |
|---|---|
| Agent LLM calls | [Groq](https://console.groq.com) — `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` |
| Embeddings | [Ollama](https://ollama.com) — `nomic-embed-text` (768-dim, runs locally) |
| Vector search | [pgvector](https://github.com/pgvector/pgvector) 0.8+ |
| Database | PostgreSQL 14+ |
| Infrastructure | [Terraform](https://www.terraform.io/) + [LocalStack](https://localstack.cloud) |
| API server | Express 5 + TypeScript |
| Real-time | Server-Sent Events (SSE) |

---

## Prerequisites

- **Node.js 18+** — `node --version`
- **PostgreSQL 14+** — with the `vector` extension (see install steps below)
- **Terraform** — `terraform -version` (1.x or 2.x)
- **Ollama** — `ollama --version`
- **LocalStack** (or the full [floci-console-docker](../floci-console-docker) stack) — `aws --endpoint-url=http://localhost:4566 s3 ls`
- **Groq API key** — free at [console.groq.com](https://console.groq.com)

---

## Installation

### 1. Clone and install

```bash
git clone https://github.com/your-org/floci-nexus
cd floci-nexus
npm install
```

### 2. Set up PostgreSQL with pgvector

**Option A — Homebrew (macOS)**

```bash
brew install postgresql@14
brew services start postgresql@14

# Build pgvector for pg14 (the Homebrew bottle targets pg17)
git clone --depth 1 https://github.com/pgvector/pgvector /tmp/pgvector
cd /tmp/pgvector
PG_CONFIG=$(brew --prefix postgresql@14)/bin/pg_config make
PG_CONFIG=$(brew --prefix postgresql@14)/bin/pg_config make install

# Create the database and user
createdb floci_agents
psql floci_agents -c "CREATE USER floci WITH PASSWORD 'floci_secret';"
psql floci_agents -c "GRANT ALL PRIVILEGES ON DATABASE floci_agents TO floci;"

# Enable pgvector (as the database owner)
psql floci_agents -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Apply schema
PGPASSWORD=floci_secret psql -h localhost -U floci -d floci_agents -f schema.sql
```

**Option B — Docker**

```bash
docker run -d \
  --name floci-postgres \
  -e POSTGRES_DB=floci_agents \
  -e POSTGRES_USER=floci \
  -e POSTGRES_PASSWORD=floci_secret \
  -p 5432:5432 \
  pgvector/pgvector:pg16

PGPASSWORD=floci_secret psql -h localhost -U floci -d floci_agents -f schema.sql
```

### 3. Install Ollama and pull the embedding model

```bash
# macOS
brew install ollama
brew services start ollama

# Pull nomic-embed-text (274 MB, CPU-friendly)
ollama pull nomic-embed-text
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — at minimum set your Groq API key:

```bash
GROQ_API_KEY=gsk_your_key_here
```

### 5. Start the server

```bash
bash start.sh
# or: npm run dev
```

The server starts on port 3002. On first boot it seeds each agent with base knowledge and backfills any missing embeddings.

```
╔═══════════════════════════════════╗
║  FLOCI NEXUS  — port 3002         ║
╚═══════════════════════════════════╝

  Dashboard:  http://localhost:3002
  SSE stream: http://localhost:3002/api/stream
  Agents:     http://localhost:3002/api/agents

✅ All agents initialised with base knowledge
  [embed] backfilled 19 memories for FORGE
```

---

## Quick start

### Submit a task via curl

```bash
curl -X POST http://localhost:3002/api/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "userMessage": "I need a serverless blog backend with S3 for uploads and a REST API"
  }'
```

Response:
```json
{ "status": "started", "taskId": "abc123..." }
```

The pipeline runs asynchronously. Watch progress via:

```bash
curl -N http://localhost:3002/api/stream
```

Or open `http://localhost:3002` for the built-in Kanban dashboard.

### Talk to an agent directly

```bash
curl -X POST http://localhost:3002/api/ask \
  -H "Content-Type: application/json" \
  -d '{"agent": "FORGE", "question": "What Terraform patterns do you remember?"}'
```

Or use the interactive shell script:

```bash
./ask.sh FORGE
```

Commands inside the shell: `/agent ARIA`, `/clear`, `/exit`.

---

## Agent memory

Each agent maintains three memory stores that persist across restarts:

| Memory type | What's stored | Decay rate |
|---|---|---|
| **Episodic** | Specific past experiences ("deployed micro-blog with S3 + Lambda") | ~13%/day |
| **Semantic** | Domain knowledge ("API Gateway REST resources use `aws_api_gateway_*`") | ~2%/day |
| **Procedural** | Skills and HCL patterns ("Lambda + IAM pattern: Step 1 create role…") | ~8%/day |

Retrieval uses **cosine similarity via pgvector** — the query is embedded with Ollama `nomic-embed-text` and the nearest memories are returned. If Ollama is unavailable the system falls back to Jaccard keyword matching.

Memory strength is boosted on every access and decays when unused. Memories below strength 0.07 are archived.

Inspect a specific agent's memory:

```bash
curl http://localhost:3002/api/memory/FORGE | jq '.procedural[] | {skill_name, strength}'
```

---

## Approval gates

By default (`AUTO_APPROVE=true`) all Terraform plans and applies are auto-approved. Set `AUTO_APPROVE=false` to require human review before each gate:

```bash
# See what's waiting
curl http://localhost:3002/api/admin/pending

# Approve a run
curl -X POST http://localhost:3002/api/admin/approve \
  -H "Content-Type: application/json" \
  -d '{"runId": "...", "action": "approve", "reason": "Looks good"}'
```

---

## Connecting to the Floci UI

The [floci-ui](../floci-ui) React frontend connects to NEXUS over two routes proxied by Nginx:

- `/nexus/api/*` → `http://localhost:3002/api/*`
- `/nexus/stream` → `http://localhost:3002/api/stream`

Run the full stack:

```bash
# In floci-ui/
docker compose -f docker-compose.console.yml up
```

Then visit `http://localhost:3000/agents` for the Pipeline view, Memory Browser, and Resource Inspector, or `http://localhost:3000/agent-console` for the conversational interface.

---

## Project structure

```
floci-nexus/
├── src/
│   ├── agents.ts             — ARIA, FORGE, SAGE, SCOUT + shared Groq client
│   ├── brain.ts              — AgentBrain: memory read/write, decay, embeddings
│   ├── orchestrator.ts       — 8-stage pipeline
│   ├── terraform-executor.ts — terraform plan/apply + provider injection
│   ├── kanban.ts             — KanbanBoard + SSE broadcast
│   ├── api.ts                — Express server + all endpoints
│   ├── db.ts                 — pg pool
│   └── public/index.html     — standalone Kanban dashboard
├── docs/
│   ├── architecture.md       — detailed system design
│   └── api.md                — complete REST reference
├── schema.sql                — authoritative database schema
├── ask.sh                    — interactive agent console (CLI)
├── start.sh                  — production start script
├── .env.example              — environment template
├── tsconfig.json
└── package.json
```

---

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | — | **Required.** Groq API key (`gsk_…`) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `floci_agents` | Database name |
| `DB_USER` | `floci` | Database user |
| `DB_PASSWORD` | `floci_secret` | Database password |
| `TERRAFORM_BASE_DIR` | `/tmp/terraform` | Root for isolated Terraform workspaces |
| `PORT` | `3002` | HTTP server port |
| `AUTO_APPROVE` | `true` | Skip manual approval gates |

---

## Troubleshooting

**`pgvector` extension not found**

The Homebrew pgvector bottle targets PostgreSQL 17. If you're on PostgreSQL 14, build from source (see install step 2A above).

**Ollama connection refused**

Ensure Ollama is running: `brew services start ollama` or `ollama serve`. The system falls back to Jaccard similarity if Ollama is down — no crash.

**`terraform` command not found**

Install Terraform: `brew install terraform` or download from [releases.hashicorp.com](https://releases.hashicorp.com/terraform/).

**Plan fails with `Error: creating S3 bucket: BucketAlreadyExists`**

A previous run left a bucket in LocalStack. Delete it:
```bash
aws --endpoint-url=http://localhost:4566 s3 rb s3://bucket-name --force
```

**State lock preventing retry**

Remove the lock file from the Terraform workspace:
```bash
rm /tmp/terraform/{userId}/{runId}/.terraform.tfstate.lock.info
```

---

## Further reading

- [Architecture deep dive](docs/architecture.md) — pipeline stages, memory decay model, vector retrieval, data flow
- [API reference](docs/api.md) — all endpoints with request/response examples
- [Contributing](CONTRIBUTING.md) — how to add Terraform patterns, report bugs, submit PRs
