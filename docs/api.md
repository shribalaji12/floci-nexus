# FLOCI NEXUS — API Reference

Base URL: `http://localhost:3002`

All request and response bodies are JSON. Errors return `{ "error": "message" }`.

---

## Pipeline

### Start a provisioning pipeline

```
POST /api/orchestrate
```

Parses requirements, generates Terraform, runs plan/apply, validates, and detects gaps. The pipeline runs asynchronously — the endpoint returns immediately with a `taskId`.

**Request**
```json
{
  "userId": "alice@example.com",
  "userMessage": "I need an S3 bucket with versioning and a Lambda function to process uploads."
}
```

**Response**
```json
{
  "status": "started",
  "taskId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Track progress via the SSE stream (`GET /api/stream`) or poll the Kanban endpoint.

---

## Agents

### List all agents with memory stats

```
GET /api/agents
```

**Response**
```json
[
  {
    "name": "ARIA",
    "full": "Adaptive Requirements Intelligence Agent",
    "emoji": "🎯",
    "color": "#00d4ff",
    "soul": "...",
    "quote": "Tell me what you need, and I'll hear what you mean.",
    "specialty": "Episodic memory — I never forget a conversation.",
    "memoryStats": {
      "episodic":   { "count": 12, "avg_strength": 0.842 },
      "semantic":   { "count": 3,  "avg_strength": 0.731 },
      "procedural": { "count": 0,  "avg_strength": 0 }
    }
  }
]
```

### Ask an agent a question (conversational)

Talks directly to one agent without triggering the infrastructure pipeline. The agent uses its memory to inform the answer.

```
POST /api/ask
```

**Request**
```json
{
  "agent": "FORGE",
  "question": "What Terraform patterns have you used for Lambda?",
  "history": [
    { "role": "user",      "content": "Hey FORGE" },
    { "role": "assistant", "content": "Hello! Ready to build." }
  ]
}
```

`history` is optional. Include prior turns to maintain conversation context.

**Response**
```json
{
  "agent": "FORGE",
  "answer": "I've used the archive_file + IAM role + Lambda pattern extensively...",
  "model": "llama-3.3-70b-versatile"
}
```

---

## Memory

### Get all memories for a specific agent

```
GET /api/memory/:agent
```

`:agent` is one of `ARIA`, `FORGE`, `SAGE`, `SCOUT` (case-insensitive).

**Response**
```json
{
  "stats": {
    "episodic":   { "count": 12, "avg_strength": 0.842 },
    "semantic":   { "count": 3,  "avg_strength": 0.731 },
    "procedural": { "count": 0,  "avg_strength": 0 }
  },
  "episodic": [
    {
      "id": "...",
      "episode_type": "requirement_gathering",
      "context": "User requested: I need a micro-blog website...",
      "outcome": "Extracted: S3 + Lambda + API Gateway",
      "strength": 0.92,
      "access_count": 3,
      "created_at": "2026-06-13T10:00:00Z"
    }
  ],
  "semantic": [...],
  "procedural": [...]
}
```

### Get all memories across all agents

```
GET /api/memories
```

Returns the same structure as above but for all four agents combined.

---

## Tasks

### Get chat messages for a task

```
GET /api/tasks/:taskId/messages
```

Returns the full conversation log for a pipeline run — user message, agent messages, and system events in chronological order.

**Response**
```json
[
  { "id": "...", "task_id": "...", "agent_name": null,    "role": "user",   "content": "I need a blog...", "created_at": "..." },
  { "id": "...", "task_id": "...", "agent_name": "ARIA",  "role": "agent",  "content": "Let me understand...", "created_at": "..." },
  { "id": "...", "task_id": "...", "agent_name": "FORGE", "role": "agent",  "content": "Forging your infrastructure...", "created_at": "..." }
]
```

### Get Terraform executions for a task

```
GET /api/tasks/:taskId/executions
```

Returns all `terraform plan` and `terraform apply` runs linked to the task, including stdout/stderr.

**Response**
```json
[
  {
    "id": "...",
    "command": "plan",
    "status": "success",
    "exit_code": 0,
    "stdout": "Plan: 5 to add, 0 to change, 0 to destroy.",
    "stderr": "",
    "execution_time_ms": 4820,
    "created_at": "..."
  }
]
```

### Get provisioned resources for a task

```
GET /api/tasks/:taskId/resources
```

Reads the Terraform state for the most recent successful run on this task and returns a flat list of resources.

**Response**
```json
{
  "resources": [
    {
      "type": "aws_s3_bucket",
      "name": "blog_bucket",
      "provider": "aws",
      "attributes": {
        "id": "blog-bucket-a3f2b1c4",
        "arn": "arn:aws:s3:::blog-bucket-a3f2b1c4",
        "bucket": "blog-bucket-a3f2b1c4"
      }
    }
  ],
  "terraform_code": "resource \"aws_s3_bucket\" \"blog_bucket\" { ... }"
}
```

---

## Kanban

### Get full board state

```
GET /api/kanban
```

Returns all tasks and agent statuses. The frontend uses the SSE stream for live updates; this endpoint is for initial load.

**Response**
```json
{
  "columns": [
    { "id": "queued",        "label": "Queued",          "agent": null    },
    { "id": "gathering",     "label": "Gathering",        "agent": "ARIA"  },
    { "id": "forging",       "label": "Forging",          "agent": "FORGE" },
    { "id": "pending_plan",  "label": "Pending Plan",     "agent": null    },
    { "id": "planning",      "label": "Planning",         "agent": null    },
    { "id": "pending_apply", "label": "Pending Apply",    "agent": null    },
    { "id": "deploying",     "label": "Deploying",        "agent": null    },
    { "id": "validating",    "label": "Validating",       "agent": "SAGE"  },
    { "id": "scouting",      "label": "Scouting",         "agent": "SCOUT" },
    { "id": "complete",      "label": "Complete",         "agent": null    },
    { "id": "failed",        "label": "Failed",           "agent": null    }
  ],
  "tasks": [...],
  "agents": [
    { "name": "ARIA", "status": "idle", "currentTask": null, "thought": null }
  ]
}
```

### Real-time event stream

```
GET /api/stream
```

Server-Sent Events. Connect once; the server pushes all pipeline events.

```
data: {"type":"task_created","payload":{...},"ts":1718270400000}

data: {"type":"agent_status","payload":{"name":"ARIA","status":"thinking","currentTask":"abc123","thought":"Listening deeply..."},"ts":1718270401000}

data: {"type":"chat_message","payload":{"taskId":"abc123","agent":"ARIA","role":"agent","content":"Got it. Here's what I've captured..."},"ts":1718270402000}

data: {"type":"task_moved","payload":{"task":{...},"column":"forging"},"ts":1718270403000}
```

---

## Admin

### List pending approvals

```
GET /api/admin/pending
```

Returns runs waiting for human review (when `AUTO_APPROVE=false`).

### Get a specific run

```
GET /api/admin/run/:id
```

### Approve or reject a run

```
POST /api/admin/approve
```

**Request**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "action": "approve",
  "reason": "Looks good — IAM scoping is appropriate."
}
```

`action` is `"approve"` or `"reject"`.

### Get capability gaps

```
GET /api/admin/gaps?status=open&priority=high
```

Both query params are optional.

**Response**
```json
{
  "count": 2,
  "gaps": [
    {
      "service_name": "RDS",
      "requested_feature": "managed relational database",
      "occurrence_count": 7,
      "priority": "critical",
      "status": "open"
    }
  ]
}
```

### Get pipeline metrics

```
GET /api/admin/metrics
```

**Response**
```json
{
  "totalRuns": 42,
  "approvedRuns": 38,
  "rejectedRuns": 2,
  "successfulDeploys": 36,
  "failedDeploys": 2,
  "openGaps": 4,
  "criticalGaps": 1,
  "approvalRate": 90.5,
  "successRate": 94.7
}
```

### Backfill vector embeddings

Run after adding new memories manually or after upgrading the embedding model.

```
POST /api/admin/backfill-embeddings
```

**Response**
```json
{
  "success": true,
  "backfilled": {
    "episodic": 5,
    "semantic": 12,
    "procedural": 3
  }
}
```
