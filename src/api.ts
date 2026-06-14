import "dotenv/config";
import express from "express";
import path from "path";
import { Pool } from "pg";
import { InfrastructureOrchestrator } from "./orchestrator";
import { KanbanBoard, addSSEClient, broadcast } from "./kanban";
import { AgentBrain } from "./brain";
import { SOULS, groqClient } from "./agents";

const pool = new Pool({
  host:     process.env.DB_HOST     ?? "localhost",
  port:     parseInt(process.env.DB_PORT ?? "5433"),
  database: process.env.DB_NAME     ?? "floci_agents",
  user:     process.env.DB_USER     ?? "floci",
  password: process.env.DB_PASSWORD ?? "floci_secret",
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const orchestrator = new InfrastructureOrchestrator(pool);
const board = new KanbanBoard(pool);

// ─────────────────────────────────────────
// Boot
// ─────────────────────────────────────────
(async () => {
  try {
    await orchestrator.init();

    // Backfill embeddings for any pre-existing memories that lack them
    (async () => {
      for (const name of ["ARIA","FORGE","SAGE","SCOUT"] as const) {
        const brain = new AgentBrain(name, pool);
        const counts = await brain.backfillEmbeddings();
        const total = counts.episodic + counts.semantic + counts.procedural;
        if (total > 0) console.log(`  [embed] backfilled ${total} memories for ${name}`);
      }
    })().catch(err => console.warn("  [embed] backfill error:", err.message));

    // Memory decay loop — every 60 s
    setInterval(async () => {
      await AgentBrain.runGlobalDecay(pool);
      const summary = await pool.query(
        `SELECT memory_type, agent_name, AVG(avg_loss) AS avg_loss
         FROM memory_decay_log WHERE created_at > NOW()-INTERVAL '70 seconds'
         GROUP BY memory_type, agent_name`
      );
      board.decayTick(summary.rows);

      // Broadcast updated memory stats for each agent
      for (const name of ["ARIA","FORGE","SAGE","SCOUT"] as const) {
        const brain = new AgentBrain(name, pool);
        const stats = await brain.getStats();
        board.memoryUpdate(name, stats);
      }
    }, 60_000);

  } catch (err) {
    console.error("Boot error:", err);
  }
})();

// ─────────────────────────────────────────
// SSE — real-time kanban stream
// ─────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  addSSEClient(res);

  // Send full state on connect
  board.getFullState().then(state => {
    res.write(`data: ${JSON.stringify({ type: "state", payload: state, ts: Date.now() })}\n\n`);
  });

  // Heartbeat
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(hb); } }, 15_000);
  res.on("close", () => clearInterval(hb));
});

// ─────────────────────────────────────────
// Agents metadata (souls)
// ─────────────────────────────────────────
app.get("/api/agents", async (_req, res) => {
  const entries = Object.entries(SOULS) as [string, typeof SOULS[keyof typeof SOULS]][];
  const stats = await Promise.all(
    entries.map(async ([, s]) => {
      const brain = new AgentBrain(s.name, pool);
      const memoryStats = await brain.getStats();
      return { name: s.name, full: s.full, emoji: s.emoji, color: s.color, soul: s.soul, quote: s.quote, specialty: s.specialty, memoryStats };
    })
  );
  res.json(stats);
});

// ─────────────────────────────────────────
// Kanban state
// ─────────────────────────────────────────
app.get("/api/kanban", async (_req, res) => {
  res.json(await board.getFullState());
});

// ─────────────────────────────────────────
// Orchestrate
// ─────────────────────────────────────────
app.post("/api/orchestrate", async (req, res) => {
  const { userId, userMessage } = req.body;
  if (!userId || !userMessage) return res.status(400).json({ error: "Missing userId or userMessage" });

  // Create task synchronously so we can return taskId immediately
  const task = await orchestrator.createTask(userId, userMessage);

  // Run rest of pipeline async
  orchestrator.runPipeline(task.id, userId, userMessage, task)
    .catch(err => console.error("Orchestration error:", err));

  res.json({ status: "started", taskId: task.id });
});

// ─────────────────────────────────────────
// Admin — pending approvals
// ─────────────────────────────────────────
app.get("/api/admin/pending", async (_req, res) => {
  const rows = await pool.query(
    `SELECT ar.id, ar.user_id, ar.stage, ar.created_at,
            LEFT(ar.terraform_code, 600) AS terraform_preview
     FROM agent_runs ar
     WHERE ar.admin_review_status='pending'
     ORDER BY ar.created_at DESC`
  );
  res.json({ count: rows.rowCount, runs: rows.rows });
});

app.get("/api/admin/run/:id", async (req, res) => {
  const row = await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [req.params.id]);
  if (!row.rowCount) return res.status(404).json({ error: "Not found" });
  res.json(row.rows[0]);
});

// ─────────────────────────────────────────
// Admin — approve / reject
// ─────────────────────────────────────────
app.post("/api/admin/approve", async (req, res) => {
  const { runId, action, reason } = req.body;
  if (!runId || !action) return res.status(400).json({ error: "Missing runId or action" });

  const run = await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [runId]);
  if (!run.rowCount) return res.status(404).json({ error: "Not found" });

  await pool.query(
    `INSERT INTO admin_approvals (run_id, terraform_code, action, reason, admin_user_id)
     VALUES ($1,$2,$3,$4,'admin')`,
    [runId, run.rows[0].terraform_code, action, reason ?? ""]
  );
  await pool.query(
    `UPDATE agent_runs SET admin_review_status=$1, admin_feedback=$2, updated_at=NOW() WHERE id=$3`,
    [action === "approve" ? "approved" : "rejected", reason ?? "", runId]
  );

  const emoji = action === "approve" ? "✅" : "❌";
  board.activity(`${emoji} Admin ${action}d run ${runId.slice(0,8)}${reason ? " — " + reason : ""}`);
  broadcast({ type: "activity", payload: { msg: `Admin ${action}: ${runId.slice(0,8)}` }, ts: Date.now() } as any);

  res.json({ success: true, action });
});

// ─────────────────────────────────────────
// Admin — gaps & metrics
// ─────────────────────────────────────────
app.get("/api/admin/gaps", async (req, res) => {
  const rows = await pool.query(
    `SELECT * FROM capability_gaps
     WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR priority=$2)
     ORDER BY occurrence_count DESC`,
    [req.query.status ?? null, req.query.priority ?? null]
  );
  res.json({ count: rows.rowCount, gaps: rows.rows });
});

app.get("/api/admin/metrics", async (_req, res) => {
  const r = await pool.query<any>(
    `SELECT
       COUNT(*) total,
       COUNT(*) FILTER (WHERE admin_review_status='approved') approved,
       COUNT(*) FILTER (WHERE admin_review_status='rejected') rejected,
       COUNT(*) FILTER (WHERE status='executed') deployed,
       COUNT(*) FILTER (WHERE status='failed') failed,
       (SELECT COUNT(*) FROM capability_gaps WHERE status='open') gaps,
       (SELECT COUNT(*) FROM capability_gaps WHERE priority IN ('high','critical')) critical_gaps
     FROM agent_runs`
  );
  const m = r.rows[0];
  res.json({
    totalRuns:       +m.total,
    approvedRuns:    +m.approved,
    rejectedRuns:    +m.rejected,
    successfulDeploys: +m.deployed,
    failedDeploys:   +m.failed,
    openGaps:        +m.gaps,
    criticalGaps:    +m.critical_gaps,
    approvalRate:    m.total > 0 ? +(+m.approved / +m.total * 100).toFixed(1) : 0,
    successRate:     m.approved > 0 ? +(+m.deployed / +m.approved * 100).toFixed(1) : 0,
  });
});

// ─────────────────────────────────────────
// Memory APIs
// ─────────────────────────────────────────
app.get("/api/memory/:agent", async (req, res) => {
  const { agent } = req.params;
  const brain = new AgentBrain(agent.toUpperCase(), pool);
  const stats = await brain.getStats();

  const [episodic, semantic, procedural] = await Promise.all([
    pool.query(`SELECT id, episode_type, context, outcome, strength, access_count, created_at FROM episodic_memories WHERE agent_name=$1 ORDER BY strength DESC LIMIT 20`, [agent.toUpperCase()]),
    pool.query(`SELECT id, category, fact, confidence, strength, created_at FROM semantic_memories WHERE agent_name=$1 ORDER BY strength DESC LIMIT 20`, [agent.toUpperCase()]),
    pool.query(`SELECT id, skill_name, description, strength, success_count, failure_count, last_used FROM procedural_memories WHERE agent_name=$1 ORDER BY strength DESC LIMIT 20`, [agent.toUpperCase()]),
  ]);

  res.json({ stats, episodic: episodic.rows, semantic: semantic.rows, procedural: procedural.rows });
});

// ─────────────────────────────────────────
// All memories across all agents
// ─────────────────────────────────────────
app.get("/api/memories", async (_req, res) => {
  const [episodic, semantic, procedural] = await Promise.all([
    pool.query(`SELECT id, agent_name, episode_type, context, outcome, strength, access_count, created_at FROM episodic_memories ORDER BY agent_name, strength DESC`),
    pool.query(`SELECT id, agent_name, category, fact, confidence, strength, created_at FROM semantic_memories ORDER BY agent_name, strength DESC`),
    pool.query(`SELECT id, agent_name, skill_name, description, procedure, strength, success_count, failure_count, last_used, created_at FROM procedural_memories ORDER BY agent_name, strength DESC`),
  ]);
  res.json({ episodic: episodic.rows, semantic: semantic.rows, procedural: procedural.rows });
});

// ─────────────────────────────────────────
// Task chat messages
// ─────────────────────────────────────────
app.get("/api/tasks/:taskId/messages", async (req, res) => {
  const rows = await pool.query(
    `SELECT id, task_id, agent_name, role, content, created_at
     FROM task_messages WHERE task_id=$1 ORDER BY created_at ASC`,
    [req.params.taskId]
  );
  res.json(rows.rows);
});

// ─────────────────────────────────────────
// Task terraform executions (agent commands)
// ─────────────────────────────────────────
app.get("/api/tasks/:taskId/executions", async (req, res) => {
  const rows = await pool.query(
    `SELECT te.id, te.command, te.status, te.exit_code, te.stdout, te.stderr, te.execution_time_ms, te.created_at
     FROM terraform_executions te
     JOIN agent_runs ar ON ar.id = te.run_id
     WHERE ar.user_id = (SELECT user_id FROM kanban_tasks WHERE id=$1)
     ORDER BY te.created_at ASC`,
    [req.params.taskId]
  );
  res.json(rows.rows);
});

// ─────────────────────────────────────────
// Task resources (from terraform state)
// ─────────────────────────────────────────
app.get("/api/tasks/:taskId/resources", async (req, res) => {
  const row = await pool.query(
    `SELECT ar.terraform_state, ar.terraform_code
     FROM agent_runs ar
     JOIN kanban_tasks kt ON kt.user_id = ar.user_id
     WHERE kt.id = $1 AND ar.terraform_state IS NOT NULL
     ORDER BY ar.created_at DESC LIMIT 1`,
    [req.params.taskId]
  );
  if (!row.rowCount) return res.json({ resources: [], terraform_code: null });

  const state = row.rows[0].terraform_state;
  const terraform_code = row.rows[0].terraform_code;
  const resources: any[] = [];

  if (state?.resources) {
    for (const r of state.resources) {
      if (r.mode === "data") continue;
      for (const inst of r.instances ?? []) {
        resources.push({
          type: r.type,
          name: r.name,
          provider: r.provider?.split("/").pop() ?? r.provider,
          attributes: inst.attributes ?? {},
        });
      }
    }
  }

  res.json({ resources, terraform_code });
});

// ─────────────────────────────────────────
// Ask an agent a question (conversational, no pipeline)
// ─────────────────────────────────────────
app.post("/api/ask", async (req, res) => {
  const { agent: agentName, question, history } = req.body as {
    agent: string; question: string; history?: { role: string; content: string }[]
  };
  if (!agentName || !question) return res.status(400).json({ error: "Missing agent or question" });

  const name = agentName.toUpperCase() as keyof typeof SOULS;
  const soul = SOULS[name];
  if (!soul) return res.status(400).json({ error: `Unknown agent: ${agentName}. Use ARIA, FORGE, SAGE, or SCOUT.` });

  const brain = new AgentBrain(name, pool);
  const memCtx = await brain.getMemoryContext(question);

  const systemPrompt = `You are ${soul.name} — ${soul.full}.
Soul: ${soul.soul}
Quote: "${soul.quote}"
Specialty: ${soul.specialty}

${memCtx ? `YOUR MEMORIES (use these to inform your answer):\n${memCtx}\n` : ""}

You are in a direct conversation with a user. Be concise, honest, and in character.
If asked about memories, infrastructure, or past work — draw on what you know from memory above.
Do NOT trigger any pipeline or pretend to provision infrastructure — just answer the question.`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...(history ?? []),
    { role: "user", content: question },
  ];

  const response = await groqClient.chat.completions.create({
    model: soul.model,
    max_tokens: 1024,
    messages,
  });

  const answer = response.choices[0].message.content ?? "";
  res.json({ agent: name, answer, model: soul.model });
});

// ─────────────────────────────────────────
// Backfill embeddings for existing memories
// ─────────────────────────────────────────
app.post("/api/admin/backfill-embeddings", async (_req, res) => {
  const totals = { episodic: 0, semantic: 0, procedural: 0 };
  for (const name of ["ARIA","FORGE","SAGE","SCOUT"] as const) {
    const brain = new AgentBrain(name, pool);
    const counts = await brain.backfillEmbeddings();
    totals.episodic   += counts.episodic;
    totals.semantic   += counts.semantic;
    totals.procedural += counts.procedural;
  }
  res.json({ success: true, backfilled: totals });
});

// Serve dashboard
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT ?? 3002;
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════╗`);
  console.log(`║  FLOCI NEXUS  — port ${PORT}         ║`);
  console.log(`╚═══════════════════════════════════╝`);
  console.log(`\n  Dashboard:  http://localhost:${PORT}`);
  console.log(`  SSE stream: http://localhost:${PORT}/api/stream`);
  console.log(`  Agents:     http://localhost:${PORT}/api/agents\n`);
});
