import { execSync, exec } from "child_process";
import path from "path";
import fs from "fs";
import { promisify } from "util";
import db from "./db";

const execAsync = promisify(exec);

interface TerraformExecutionResult {
  status: "success" | "error";
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTime: number;
}

export class TerraformExecutor {
  private workdir: string;

  constructor(
    private userId: string,
    private runId: string
  ) {
    this.workdir = path.join(
      process.env.TERRAFORM_BASE_DIR || "/tmp/terraform",
      userId,
      runId
    );
    this.ensureWorkdir();
  }

  private ensureWorkdir() {
    if (!fs.existsSync(this.workdir)) {
      fs.mkdirSync(this.workdir, { recursive: true });
    }
  }

  async writeTerraformCode(code: string): Promise<void> {
    const mainFile = path.join(this.workdir, "main.tf");
    fs.writeFileSync(mainFile, code, "utf-8");

    const providerFile = path.join(this.workdir, "providers.tf");
    fs.writeFileSync(providerFile, this.getProviderConfig(), "utf-8");

    console.log(`[${this.runId}] Terraform files written to ${this.workdir}`);
  }

  private getProviderConfig(): string {
    return `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region     = var.aws_region
  access_key = var.aws_access_key_id
  secret_key = var.aws_secret_access_key
  skip_credentials_validation  = true
  skip_region_validation       = true
  skip_requesting_account_id   = true
  skip_metadata_api_check      = true

  endpoints {
    s3           = var.floci_endpoint
    dynamodb     = var.floci_endpoint
    lambda       = var.floci_endpoint
    ec2          = var.floci_endpoint
    iam          = var.floci_endpoint
    sqs          = var.floci_endpoint
    sns          = var.floci_endpoint
    apigateway   = var.floci_endpoint
    apigatewayv2 = var.floci_endpoint
    cloudwatch   = var.floci_endpoint
    logs         = var.floci_endpoint
    secretsmanager = var.floci_endpoint
  }
}

variable "aws_region" {
  default = "us-east-1"
}

variable "aws_access_key_id" {
  default = "test"
  sensitive = true
}

variable "aws_secret_access_key" {
  default = "test"
  sensitive = true
}

variable "floci_endpoint" {
  default = "http://localhost:4566"
}

variable "aws_account_id" {
  default = "000000000000"
}
`;
  }

  async init(): Promise<void> {
    if (fs.existsSync(path.join(this.workdir, ".terraform"))) {
      console.log(`[${this.runId}] Terraform already initialized`);
      return;
    }

    console.log(`[${this.runId}] Initializing Terraform...`);
    try {
      execSync("terraform init -no-color", {
        cwd: this.workdir,
        stdio: "pipe",
        env: { ...process.env, TF_IN_AUTOMATION: "true" },
      });
    } catch (e: any) {
      console.error(`[${this.runId}] Init error: ${e.message}`);
      // Continue anyway, might have partial state
    }
  }

  async plan(): Promise<TerraformExecutionResult> {
    return this.executeCommand("plan");
  }

  async apply(): Promise<TerraformExecutionResult> {
    return this.executeCommand("apply", ["-auto-approve", "-no-color"]);
  }

  async destroy(): Promise<TerraformExecutionResult> {
    return this.executeCommand("destroy", ["-auto-approve", "-no-color"]);
  }

  private async executeCommand(
    command: string,
    args: string[] = []
  ): Promise<TerraformExecutionResult> {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      // Init first
      await this.init();

      const fullCommand = `terraform ${command} ${args.join(" ")}`;
      console.log(
        `[${this.runId}] Executing: ${fullCommand} in ${this.workdir}`
      );

      const { stdout: out, stderr: err } = await execAsync(fullCommand, {
        cwd: this.workdir,
        env: { ...process.env, TF_IN_AUTOMATION: "true" },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000, // 5 minutes
      });

      stdout = out;
      stderr = err;

      // Log to database
      const tfCode = fs.readFileSync(path.join(this.workdir, "main.tf"), "utf-8");
      await db.createTerraformExecution({
        run_id: this.runId,
        terraform_code: tfCode,
        command,
        status: "success",
        exit_code: 0,
        stdout,
        stderr,
        execution_time_ms: Date.now() - startTime,
      });

      console.log(`[${this.runId}] ${command} succeeded`);

      return {
        status: "success",
        exitCode: 0,
        stdout,
        stderr,
        executionTime: Date.now() - startTime,
      };
    } catch (error: any) {
      stderr = error.stderr || error.message;
      exitCode = error.code || 1;

      console.error(
        `[${this.runId}] ${command} failed: ${error.message}`
      );

      // Log failure
      const tfCode = fs.existsSync(path.join(this.workdir, "main.tf"))
        ? fs.readFileSync(path.join(this.workdir, "main.tf"), "utf-8")
        : "";

      await db.createTerraformExecution({
        run_id: this.runId,
        terraform_code: tfCode,
        command,
        status: "error",
        exit_code: exitCode,
        stdout,
        stderr,
        execution_time_ms: Date.now() - startTime,
      });

      return {
        status: "error",
        exitCode,
        stdout,
        stderr,
        executionTime: Date.now() - startTime,
      };
    }
  }

  async getState(): Promise<any> {
    try {
      const stateFile = path.join(this.workdir, "terraform.tfstate");
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        return state;
      }
      return null;
    } catch (e) {
      console.error("Failed to read state:", e);
      return null;
    }
  }

}
