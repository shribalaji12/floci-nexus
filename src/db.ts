import { Pool } from "pg";

const pool = new Pool({
  host:     process.env.DB_HOST     ?? "localhost",
  port:     parseInt(process.env.DB_PORT ?? "5433"),
  database: process.env.DB_NAME     ?? "floci_agents",
  user:     process.env.DB_USER     ?? "floci",
  password: process.env.DB_PASSWORD ?? "floci_secret",
});

export const db = {
  async createTerraformExecution(data: {
    run_id: string;
    terraform_code: string;
    command: string;
    status: string;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    execution_time_ms?: number;
  }) {
    await pool.query(
      `INSERT INTO terraform_executions (run_id, terraform_code, command, status, exit_code, stdout, stderr, execution_time_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        data.run_id,
        data.terraform_code,
        data.command,
        data.status,
        data.exit_code ?? null,
        data.stdout ?? "",
        data.stderr ?? "",
        data.execution_time_ms ?? 0,
      ]
    );
  },
};

export default db;
