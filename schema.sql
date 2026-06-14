-- ================================================================
-- FLOCI NEXUS — Database Schema
-- PostgreSQL 14+ with pgvector extension required
-- ================================================================

-- Enable pgvector (must be run as superuser once per database)
CREATE EXTENSION IF NOT EXISTS vector;

-- ================================================================
-- PIPELINE TABLES
-- ================================================================

-- Full audit trail of all agent pipeline runs
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT    NOT NULL,
  run_type            TEXT    NOT NULL,           -- 'requirements' | 'codegen'
  stage               TEXT    NOT NULL,
  input               JSONB   NOT NULL,
  output              TEXT    NOT NULL,
  metadata            JSONB,
  status              TEXT    DEFAULT 'pending',  -- 'pending' | 'executed' | 'failed'
  terraform_code      TEXT,
  terraform_state     JSONB,
  admin_feedback      TEXT,
  admin_review_status TEXT    DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected' | 'auto-approved'
  capability_gaps     TEXT[]  DEFAULT '{}',
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user    ON agent_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status  ON agent_runs(admin_review_status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);

-- Terraform plan/apply execution history
CREATE TABLE IF NOT EXISTS terraform_executions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID REFERENCES agent_runs(id),
  terraform_code   TEXT NOT NULL,
  command          TEXT NOT NULL,    -- 'plan' | 'apply'
  status           TEXT NOT NULL,    -- 'success' | 'error'
  exit_code        INT,
  stdout           TEXT,
  stderr           TEXT,
  execution_time_ms INT,
  created_at       TIMESTAMP DEFAULT NOW(),
  completed_at     TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_executions_run    ON terraform_executions(run_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON terraform_executions(status);

-- Admin approval decisions
CREATE TABLE IF NOT EXISTS admin_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES agent_runs(id),
  terraform_code  TEXT NOT NULL,
  action          TEXT,              -- 'approve' | 'reject'
  reason          TEXT,
  admin_user_id   TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_run ON admin_approvals(run_id);

-- Capability gaps detected by SCOUT
CREATE TABLE IF NOT EXISTS capability_gaps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name      TEXT NOT NULL,
  requested_feature TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  first_seen        TIMESTAMP DEFAULT NOW(),
  occurrence_count  INT DEFAULT 1,
  priority          TEXT,            -- 'low' | 'medium' | 'high' | 'critical'
  status            TEXT DEFAULT 'open',
  run_id            UUID REFERENCES agent_runs(id),
  UNIQUE(service_name, requested_feature)
);

CREATE INDEX IF NOT EXISTS idx_gaps_priority ON capability_gaps(priority, status);

-- ================================================================
-- KANBAN BOARD
-- ================================================================

CREATE TABLE IF NOT EXISTS kanban_tasks (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT  NOT NULL,
  title       TEXT  NOT NULL,
  description TEXT  NOT NULL,
  column_id   TEXT  NOT NULL DEFAULT 'queued',
  agent_name  TEXT,
  run_id      UUID,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_column  ON kanban_tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_kanban_created ON kanban_tasks(created_at DESC);

-- Real-time chat messages per task (streamed via SSE)
CREATE TABLE IF NOT EXISTS task_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL,
  agent_name TEXT,
  role       TEXT NOT NULL,   -- 'user' | 'agent' | 'system'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);

-- ================================================================
-- AGENT MEMORY SYSTEM (AgentBrain)
-- ================================================================

-- Episodic memory: specific past experiences
CREATE TABLE IF NOT EXISTS episodic_memories (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name   TEXT  NOT NULL,
  episode_type TEXT  NOT NULL,        -- 'requirement_gathering' | 'gap_discovered' | etc.
  context      TEXT  NOT NULL,
  outcome      TEXT  NOT NULL,
  keywords     TEXT[] DEFAULT '{}',
  embedding    vector(768),            -- nomic-embed-text via Ollama
  strength     FLOAT DEFAULT 1.0,     -- 0..1; decays via Ebbinghaus curve
  access_count INT   DEFAULT 0,
  last_accessed TIMESTAMP DEFAULT NOW(),
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent    ON episodic_memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_episodic_strength ON episodic_memories(strength DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_keywords ON episodic_memories USING GIN(keywords);
-- Vector index (created after sufficient data; drop and recreate if recall is low)
-- CREATE INDEX idx_episodic_embedding ON episodic_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Semantic memory: domain facts and rules
CREATE TABLE IF NOT EXISTS semantic_memories (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name          TEXT  NOT NULL,
  category            TEXT  NOT NULL,  -- 'terraform_rule' | 'floci_capability' | 'user_pattern' | etc.
  fact                TEXT  NOT NULL,
  confidence          FLOAT DEFAULT 1.0,
  supporting_evidence INT   DEFAULT 1,
  keywords            TEXT[] DEFAULT '{}',
  embedding           vector(768),
  strength            FLOAT DEFAULT 1.0,
  last_accessed       TIMESTAMP DEFAULT NOW(),
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_agent    ON semantic_memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memories(category);
CREATE INDEX IF NOT EXISTS idx_semantic_keywords ON semantic_memories USING GIN(keywords);

-- Procedural memory: skills and patterns
CREATE TABLE IF NOT EXISTS procedural_memories (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name    TEXT  NOT NULL,
  skill_name    TEXT  NOT NULL,
  description   TEXT  NOT NULL,
  procedure     TEXT  NOT NULL,       -- concrete HCL template or step-by-step recipe
  keywords      TEXT[] DEFAULT '{}',
  embedding     vector(768),
  success_count INT   DEFAULT 1,
  failure_count INT   DEFAULT 0,
  strength      FLOAT DEFAULT 1.0,
  last_used     TIMESTAMP DEFAULT NOW(),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procedural_agent    ON procedural_memories(agent_name);
CREATE INDEX IF NOT EXISTS idx_procedural_strength ON procedural_memories(strength DESC);
CREATE INDEX IF NOT EXISTS idx_procedural_keywords ON procedural_memories USING GIN(keywords);

-- Decay audit log (populated every 60 s by the background loop)
CREATE TABLE IF NOT EXISTS memory_decay_log (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_type TEXT  NOT NULL,    -- 'episodic' | 'semantic' | 'procedural'
  agent_name  TEXT  NOT NULL,
  archived    INT   DEFAULT 0,   -- memories that fell below archive threshold
  decayed     INT   DEFAULT 0,   -- memories that lost strength this cycle
  avg_loss    FLOAT DEFAULT 0,
  created_at  TIMESTAMP DEFAULT NOW()
);
