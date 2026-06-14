import { Response } from "express";
import { Pool } from "pg";

// ──────────────────────────────────────────
// Column definitions (pipeline order)
// ──────────────────────────────────────────
export const COLUMNS = [
  { id: "queued",        label: "Queued",          agent: null      },
  { id: "gathering",     label: "Gathering",        agent: "ARIA"    },
  { id: "forging",       label: "Forging",          agent: "FORGE"   },
  { id: "pending_plan",  label: "Pending Plan",     agent: null      },
  { id: "planning",      label: "Planning",         agent: null      },
  { id: "pending_apply", label: "Pending Apply",    agent: null      },
  { id: "deploying",     label: "Deploying",        agent: null      },
  { id: "validating",    label: "Validating",       agent: "SAGE"    },
  { id: "scouting",      label: "Scouting",         agent: "SCOUT"   },
  { id: "complete",      label: "Complete",         agent: null      },
  { id: "failed",        label: "Failed",           agent: null      },
];

export type ColumnId = typeof COLUMNS[number]["id"];

export interface KanbanTask {
  id: string;
  user_id: string;
  title: string;
  description: string;
  column_id: ColumnId;
  agent_name?: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface SSEEvent {
  type:
    | "state"
    | "task_created"
    | "task_moved"
    | "task_updated"
    | "task_done"
    | "agent_status"
    | "memory_update"
    | "gap_detected"
    | "activity"
    | "decay_tick"
    | "chat_message";
  payload: any;
  ts: number;
}

export async function addChatMessage(
  pool: Pool,
  taskId: string,
  agent: string | null,
  role: "user" | "agent" | "system",
  content: string
): Promise<void> {
  await pool.query(
    `INSERT INTO task_messages (task_id, agent_name, role, content) VALUES ($1,$2,$3,$4)`,
    [taskId, agent, role, content]
  );
  broadcast({ type: "chat_message", payload: { taskId, agent, role, content }, ts: Date.now() });
}

// ──────────────────────────────────────────
// SSE client registry
// ──────────────────────────────────────────
const clients = new Set<Response>();

export function addSSEClient(res: Response) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function broadcast(event: SSEEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

// ──────────────────────────────────────────
// Agent live status (in-memory)
// ──────────────────────────────────────────
interface AgentStatus {
  name: string;
  status: "idle" | "thinking" | "working";
  currentTask?: string;
  thought?: string;
}

const agentStatus = new Map<string, AgentStatus>([
  ["ARIA",  { name: "ARIA",  status: "idle" }],
  ["FORGE", { name: "FORGE", status: "idle" }],
  ["SAGE",  { name: "SAGE",  status: "idle" }],
  ["SCOUT", { name: "SCOUT", status: "idle" }],
]);

export function setAgentStatus(name: string, status: AgentStatus["status"], taskId?: string, thought?: string) {
  const prev = agentStatus.get(name) ?? { name, status: "idle" };
  const next = { ...prev, status, currentTask: taskId, thought };
  agentStatus.set(name, next);
  broadcast({ type: "agent_status", payload: next, ts: Date.now() });
}

export function getAgentStatuses() {
  return [...agentStatus.values()];
}

// ──────────────────────────────────────────
// Board operations
// ──────────────────────────────────────────
export class KanbanBoard {
  constructor(private pool: Pool) {}

  async createTask(data: { user_id: string; description: string }): Promise<KanbanTask> {
    const title = data.description.slice(0, 60) + (data.description.length > 60 ? "…" : "");
    const result = await this.pool.query<KanbanTask>(
      `INSERT INTO kanban_tasks (user_id, title, description) VALUES ($1,$2,$3) RETURNING *`,
      [data.user_id, title, data.description]
    );
    const task = result.rows[0];
    broadcast({ type: "task_created", payload: task, ts: Date.now() });
    this.activity(`Task #${task.id.slice(0,8)} created by ${data.user_id}`);
    return task;
  }

  async moveTask(taskId: string, column: ColumnId, agentName?: string, meta?: any): Promise<KanbanTask> {
    const result = await this.pool.query<KanbanTask>(
      `UPDATE kanban_tasks
       SET column_id=$1, agent_name=$2, metadata=metadata||$3::jsonb, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [column, agentName ?? null, JSON.stringify(meta ?? {}), taskId]
    );
    const task = result.rows[0];
    broadcast({ type: "task_moved", payload: { task, column }, ts: Date.now() });
    const colLabel = COLUMNS.find(c => c.id === column)?.label ?? column;
    const who = agentName ? `[${agentName}] ` : "";
    this.activity(`${who}Task #${taskId.slice(0,8)} → ${colLabel}`);
    return task;
  }

  async getFullState(): Promise<{ columns: typeof COLUMNS; tasks: KanbanTask[]; agents: AgentStatus[] }> {
    const result = await this.pool.query<KanbanTask>(
      `SELECT * FROM kanban_tasks ORDER BY created_at DESC LIMIT 200`
    );
    return { columns: COLUMNS, tasks: result.rows, agents: getAgentStatuses() };
  }

  activity(msg: string) {
    broadcast({ type: "activity", payload: { msg, ts: Date.now() }, ts: Date.now() });
  }

  gap(service: string, feature: string, severity: string) {
    broadcast({ type: "gap_detected", payload: { service, feature, severity, ts: Date.now() }, ts: Date.now() });
    this.activity(`🚩 Gap detected: ${service} — ${feature}`);
  }

  memoryUpdate(agent: string, stats: any) {
    broadcast({ type: "memory_update", payload: { agent, stats }, ts: Date.now() });
  }

  decayTick(summary: any) {
    broadcast({ type: "decay_tick", payload: summary, ts: Date.now() });
  }
}
