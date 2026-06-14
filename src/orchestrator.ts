import { v4 as uuid } from "uuid";
import { Pool } from "pg";
import { ARIA, FORGE, SAGE, SCOUT } from "./agents";
import { KanbanBoard, addChatMessage } from "./kanban";
import { TerraformExecutor } from "./terraform-executor";

export class InfrastructureOrchestrator {
  private aria:  ARIA;
  private forge: FORGE;
  private sage:  SAGE;
  private scout: SCOUT;
  private board: KanbanBoard;

  constructor(readonly pool: Pool) {
    this.aria  = new ARIA(pool);
    this.forge = new FORGE(pool);
    this.sage  = new SAGE(pool);
    this.scout = new SCOUT(pool);
    this.board = new KanbanBoard(pool);
  }

  async init() {
    await Promise.all([
      this.aria.init(),
      this.forge.init(),
      this.sage.init(),
      this.scout.init(),
    ]);
    console.log("✅ All agents initialised with base knowledge");
  }

  async createTask(userId: string, userMessage: string) {
    const task = await this.board.createTask({ user_id: userId, description: userMessage });
    await addChatMessage(this.pool, task.id, null, "user", userMessage);
    return task;
  }

  async runPipeline(taskId: string, userId: string, userMessage: string, task: any): Promise<any> {
    const runId = uuid();
    console.log(`\n${"═".repeat(60)}\n[${runId}] Pipeline started for task ${taskId}\n${"═".repeat(60)}`);
    try {
      // ── STAGE 1: Requirements (ARIA) ─────────────────────────
      await this.board.moveTask(taskId, "gathering", "ARIA");
      console.log("\n[STAGE 1] ARIA gathering requirements…");

      const { requirements, memoryStats: ariaMem } = await this.aria.gatherRequirements(userMessage, taskId);
      this.board.memoryUpdate("ARIA", ariaMem);
      console.log("Requirements:", JSON.stringify(requirements, null, 2));

      await this.pool.query(
        `INSERT INTO agent_runs (user_id, run_type, stage, input, output, admin_review_status)
         VALUES ($1,'requirements','requirements',$2,$3,'auto-approved')`,
        [userId, JSON.stringify({ userMessage }), JSON.stringify(requirements)]
      );

      // ── STAGE 2: Terraform CodeGen (FORGE) ───────────────────
      await this.board.moveTask(taskId, "forging", "FORGE");
      console.log("\n[STAGE 2] FORGE generating Terraform…");

      const { code: terraformCode, memoryStats: forgeMem } = await this.forge.generateTerraform(requirements, taskId);
      this.board.memoryUpdate("FORGE", forgeMem);
      console.log(`Generated ${terraformCode.length} chars of Terraform`);

      const codegenRow = await this.pool.query(
        `INSERT INTO agent_runs (user_id, run_type, stage, input, output, terraform_code, admin_review_status)
         VALUES ($1,'codegen','codegen',$2,$3,$4,'pending') RETURNING id`,
        [userId, JSON.stringify(requirements), terraformCode, terraformCode]
      );
      const codegenId: string = codegenRow.rows[0].id;

      // ── STAGE 3: Admin approval — Plan ───────────────────────
      await this.board.moveTask(taskId, "pending_plan", undefined, { codegenId });
      console.log("\n[STAGE 3] Awaiting admin approval for plan…");
      this.board.activity(`⏳ Task #${taskId.slice(0,8)} waiting for admin plan approval`);
      await addChatMessage(this.pool, taskId, null, "system", "⏳ Waiting for admin to review the Terraform plan before deployment proceeds.");

      const planApproved = await this.waitForAdminApproval(codegenId);
      if (!planApproved) {
        await this.board.moveTask(taskId, "failed", undefined, { reason: "Admin rejected plan" });
        return { status: "rejected", taskId, message: "Plan rejected by admin" };
      }

      // ── STAGE 4: Terraform Plan ───────────────────────────────
      await this.board.moveTask(taskId, "planning");
      console.log("\n[STAGE 4] Running terraform plan…");

      const executor = new TerraformExecutor(userId, codegenId);
      let currentCode = terraformCode;
      let planResult = { status: "error" as "success" | "error", stderr: "", stdout: "", exitCode: 0, executionTime: 0 };

      for (let attempt = 0; attempt < 3; attempt++) {
        await executor.writeTerraformCode(currentCode);
        planResult = await executor.plan();
        console.log(`Plan attempt ${attempt + 1}: ${planResult.status}`);
        if (planResult.status === "success") break;

        if (attempt < 2) {
          console.log("Plan failed — asking FORGE to fix…");
          currentCode = await this.forge.fixTerraform(currentCode, planResult.stderr, taskId);
        }
      }

      if (planResult.status === "error") {
        await this.board.moveTask(taskId, "failed", undefined, { error: planResult.stderr.slice(0, 200) });
        return { status: "error", taskId, error: planResult.stderr };
      }

      // ── STAGE 5: Admin approval — Apply ──────────────────────
      await this.board.moveTask(taskId, "pending_apply");
      console.log("\n[STAGE 5] Awaiting admin approval for apply…");
      this.board.activity(`⏳ Task #${taskId.slice(0,8)} waiting for admin apply approval`);
      await addChatMessage(this.pool, taskId, null, "system", "✅ Plan approved. Waiting for admin to approve the actual apply (deployment).");

      const applyApproved = await this.waitForAdminApproval(codegenId, "apply");
      if (!applyApproved) {
        await this.board.moveTask(taskId, "failed", undefined, { reason: "Admin rejected apply" });
        return { status: "rejected", taskId, message: "Apply rejected by admin" };
      }

      // ── STAGE 6: Terraform Apply ──────────────────────────────
      await this.board.moveTask(taskId, "deploying");
      console.log("\n[STAGE 6] Applying Terraform…");
      this.board.activity(`🚀 Task #${taskId.slice(0,8)} deploying infrastructure`);

      const applyResult = await executor.apply();
      console.log(`Apply: ${applyResult.status}`);

      if (applyResult.status === "error") {
        await this.board.moveTask(taskId, "failed", undefined, { error: applyResult.stderr.slice(0, 200) });
        await this.pool.query(`UPDATE agent_runs SET status='failed' WHERE id=$1`, [codegenId]);
        return { status: "error", taskId, error: applyResult.stderr };
      }

      const tfState = await executor.getState();
      await this.pool.query(`UPDATE agent_runs SET status='executed', terraform_state=$1 WHERE id=$2`, [JSON.stringify(tfState), codegenId]);

      // ── STAGE 7: Validation (SAGE) ────────────────────────────
      await this.board.moveTask(taskId, "validating", "SAGE");
      console.log("\n[STAGE 7] SAGE validating…");

      const validationResult = await this.sage.validate(requirements, tfState, applyResult.stdout, taskId);
      this.board.memoryUpdate("SAGE", validationResult.memoryStats);
      console.log("Validation:", JSON.stringify(validationResult, null, 2));

      // ── STAGE 8: Gap Detection (SCOUT) ────────────────────────
      await this.board.moveTask(taskId, "scouting", "SCOUT");
      console.log("\n[STAGE 8] SCOUT detecting capability gaps…");

      const gaps = await this.scout.detectGaps(requirements, terraformCode, taskId);
      const scoutStats = await this.scout.getStats();
      this.board.memoryUpdate("SCOUT", scoutStats);

      for (const gap of gaps) {
        this.board.gap(gap.service, gap.feature, gap.severity);
        await this.pool.query(
          `INSERT INTO capability_gaps (service_name, requested_feature, user_id, priority, run_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (service_name, requested_feature) DO UPDATE SET occurrence_count=capability_gaps.occurrence_count+1`,
          [gap.service, gap.feature, userId, gap.severity, codegenId]
        );
      }

      // ── COMPLETE ──────────────────────────────────────────────
      await this.board.moveTask(taskId, "complete", undefined, {
        validationPassed: validationResult.passed,
        gapsFound: gaps.length,
      });

      const finalMsg = gaps.length
        ? `🎉 All done! Infrastructure is live. ${gaps.length} gap(s) have been flagged to the admin for future Floci improvements.`
        : `🎉 All done! Infrastructure is live and fully validated. No capability gaps found.`;
      await addChatMessage(this.pool, taskId, null, "system", finalMsg);

      if (gaps.length)
        this.board.activity(`✅ Task #${taskId.slice(0,8)} complete — ${gaps.length} gap(s) flagged to admin`);
      else
        this.board.activity(`✅ Task #${taskId.slice(0,8)} complete — all checks passed`);

      return {
        status: validationResult.passed ? "success" : "partial",
        taskId,
        validationResult,
        capabilityGaps: gaps,
        terraformCode,
        tfState,
      };

    } catch (err: any) {
      console.error(`Pipeline error: ${err.message}`);
      await this.board.moveTask(taskId, "failed", undefined, { error: err.message.slice(0, 200) });
      await addChatMessage(this.pool, taskId, null, "system", `❌ Error: ${err.message.slice(0, 200)}`);
      return { status: "error", taskId, error: err.message };
    }
  }

  private async waitForAdminApproval(codegenId: string, stage = "plan"): Promise<boolean> {
    if (process.env.AUTO_APPROVE === "true") {
      console.log("  (AUTO_APPROVE — skipping wait)");
      return true;
    }

    let attempts = 0;
    while (attempts < 3600) {
      const row = await this.pool.query(
        `SELECT action FROM admin_approvals WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [codegenId]
      );
      if (row.rows.length) return row.rows[0].action === "approve";
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
      if (attempts % 10 === 0) process.stdout.write(".");
    }
    throw new Error("Admin approval timeout");
  }
}
