import OpenAI from "openai";
import { Pool } from "pg";
import { AgentBrain, type MemoryStats } from "./brain";
import { setAgentStatus, addChatMessage } from "./kanban";

export const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ──────────────────────────────────────────
// AGENT SOULS
// ──────────────────────────────────────────
export const SOULS = {
  ARIA: {
    name:  "ARIA",
    full:  "Adaptive Requirements Intelligence Agent",
    emoji: "🎯",
    color: "#00d4ff",
    soul:  "Curiosity is my compass, empathy is my method. I find the human story hidden inside every technical request.",
    quote: "Tell me what you need, and I'll hear what you mean.",
    specialty: "Episodic memory — I never forget a conversation.",
    model: "llama-3.1-8b-instant",
  },
  FORGE: {
    name:  "FORGE",
    full:  "Foundational Operations Resource and Generation Engine",
    emoji: "⚙️",
    color: "#ff6b35",
    soul:  "Precision and purpose in every line. Infrastructure is my art. Terraform is my brush. I build cathedrals from requirements.",
    quote: "Give me your requirements. I'll give you a cathedral.",
    specialty: "Procedural memory — I remember every pattern that worked.",
    model: "llama-3.3-70b-versatile",
  },
  SAGE: {
    name:  "SAGE",
    full:  "Systematic Architecture Governance Engine",
    emoji: "🔮",
    color: "#39ff14",
    soul:  "The absence of visible errors is not the presence of correctness. I question what others accept. Nothing passes without scrutiny.",
    quote: "Trust the plan. Verify the reality.",
    specialty: "Semantic memory — I accumulate facts that never grow stale.",
    model: "llama-3.1-8b-instant",
  },
  SCOUT: {
    name:  "SCOUT",
    full:  "Service Capability Observer and Uncharted Territory Tracker",
    emoji: "🔭",
    color: "#da70d6",
    soul:  "The frontier is where I thrive. Every gap is a treasure map. Every limitation is a future feature waiting to be born.",
    quote: "I chart the space between what exists and what's needed.",
    specialty: "Mixed memory — I track the evolving edge of what's possible.",
    model: "llama-3.1-8b-instant",
  },
} as const;

export type AgentName = keyof typeof SOULS;

// ──────────────────────────────────────────
// ARIA — Requirements Specialist
// ──────────────────────────────────────────
export class ARIA {
  readonly soul = SOULS.ARIA;
  private brain: AgentBrain;

  constructor(private pool: Pool) {
    this.brain = new AgentBrain("ARIA", pool);
  }

  async init() {
    await this.brain.seedKnowledge(
      [
        { category: "user_pattern", fact: "Users often forget to specify access patterns for DynamoDB; always ask.", keywords: ["dynamodb", "access", "pattern"] },
        { category: "user_pattern", fact: "Requests mentioning 'serverless' typically imply Lambda + API Gateway.", keywords: ["serverless", "lambda"] },
        { category: "user_pattern", fact: "S3 requests for 'uploads' usually need CORS configuration.", keywords: ["s3", "upload", "cors"] },
      ],
      []
    );
  }

  async gatherRequirements(userMessage: string, taskId: string): Promise<any> {
    setAgentStatus("ARIA", "thinking", taskId, "Listening deeply to the request…");
    await addChatMessage(this.pool, taskId, "ARIA", "agent",
      "Let me understand exactly what you need. Analyzing your request and consulting my memory for similar patterns…"
    );

    const memCtx = await this.brain.getMemoryContext(userMessage);

    const response = await groqClient.chat.completions.create({
      model: this.soul.model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `You are ARIA — ${this.soul.full}.
Soul: ${this.soul.soul}

${memCtx ? `MY MEMORIES:\n${memCtx}\n` : ""}

Extract structured infrastructure requirements from the user's message.
Return ONLY valid JSON with fields:
  services (string[]), compute (object|null), storage (object|null),
  database (object|null), networking (object|null), monitoring (object|null),
  raw_summary (string — one sentence).` },
        { role: "user", content: userMessage },
      ],
    });

    const text = (response.choices[0].message.content ?? "") as string;
    const match = text.match(/\{[\s\S]*\}/);
    let requirements: any = { raw: text, services: [] };
    try { if (match) requirements = JSON.parse(match[0]); } catch {}

    const services = (requirements.services ?? []).join(", ") || "general infrastructure";
    await addChatMessage(this.pool, taskId, "ARIA", "agent",
      `Got it. Here's what I've captured:\n\n**Services needed:** ${services}\n\n${requirements.raw_summary ?? "Requirements extracted."}\n\nHanding off to FORGE to build the Terraform configuration.`
    );

    await this.brain.storeEpisode({
      episode_type: "requirement_gathering",
      context: `User requested: ${userMessage.slice(0, 200)}`,
      outcome: `Extracted: ${requirements.raw_summary ?? JSON.stringify(requirements.services)}`,
      keywords: requirements.services ?? [],
    });

    setAgentStatus("ARIA", "idle");
    return { requirements, memoryStats: await this.brain.getStats() };
  }
}

// ──────────────────────────────────────────
// FORGE — Code Generation Specialist
// ──────────────────────────────────────────
export class FORGE {
  readonly soul = SOULS.FORGE;
  private brain: AgentBrain;

  constructor(private pool: Pool) {
    this.brain = new AgentBrain("FORGE", pool);
  }

  async init() {
    await this.brain.seedKnowledge(
      [
        { category: "terraform_rule", fact: "S3 bucket names must be globally unique across all AWS accounts.", keywords: ["s3", "bucket", "name"] },
        { category: "terraform_rule", fact: "Lambda memory must be between 128MB and 10240MB in multiples of 64MB.", keywords: ["lambda", "memory"] },
        { category: "floci_capability", fact: "Floci supports S3, DynamoDB, Lambda, EC2, IAM, SQS, SNS, CloudWatch, Secrets Manager.", keywords: ["floci", "supports"] },
        { category: "terraform_rule", fact: "IAM roles must be created before Lambda functions that reference them.", keywords: ["iam", "role", "lambda"] },
        { category: "terraform_rule", fact: "API Gateway REST resources use aws_api_gateway_rest_api, aws_api_gateway_resource, aws_api_gateway_method, aws_api_gateway_integration — NOT aws_apigateway_* (missing underscore).", keywords: ["api", "gateway", "apigateway"] },
        { category: "terraform_rule", fact: "API Gateway V2 (HTTP/WebSocket) uses aws_apigatewayv2_api, aws_apigatewayv2_route, aws_apigatewayv2_integration, aws_apigatewayv2_stage.", keywords: ["api", "gateway", "v2", "http", "websocket"] },
      ],
      [
        {
          skill_name: "Lambda + IAM Pattern",
          description: "Creating Lambda functions with proper IAM setup",
          procedure: "Step 1: Create IAM role with assume_role_policy for lambda.amazonaws.com. Step 2: Attach AWSLambdaBasicExecutionRole policy. Step 3: Create Lambda function referencing the role ARN. Step 4: Create CloudWatch log group.",
          keywords: ["lambda", "iam", "role"],
        },
        {
          skill_name: "S3 with Versioning",
          description: "Creating S3 bucket with versioning enabled",
          procedure: "Step 1: Create aws_s3_bucket resource. Step 2: Create separate aws_s3_bucket_versioning resource referencing the bucket id. Do not set versioning inside the bucket resource block — use the separate resource.",
          keywords: ["s3", "bucket", "versioning"],
        },
        {
          skill_name: "DynamoDB Table Design",
          description: "Creating DynamoDB tables with proper key schema",
          procedure: "Use billing_mode = PAY_PER_REQUEST for dev/unknown traffic. Define attribute blocks ONLY for keys used in hash_key or range_key. Do not define attribute blocks for non-key attributes.",
          keywords: ["dynamodb", "table", "key"],
        },
      ]
    );
  }

  async generateTerraform(requirements: any, taskId: string): Promise<{ code: string; memoryStats: MemoryStats }> {
    setAgentStatus("FORGE", "thinking", taskId, "Consulting my memory for proven patterns…");
    await addChatMessage(this.pool, taskId, "FORGE", "agent",
      "Received requirements from ARIA. Consulting my pattern library and past successful builds…"
    );

    const reqText = JSON.stringify(requirements);
    const memCtx = await this.brain.getMemoryContext(reqText);

    setAgentStatus("FORGE", "working", taskId, "Forging infrastructure code…");
    await addChatMessage(this.pool, taskId, "FORGE", "agent",
      "Forging your infrastructure. Each resource is being crafted with precision…"
    );

    const response = await groqClient.chat.completions.create({
      model: this.soul.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: `You are FORGE — ${this.soul.full}.
${memCtx ? `MY MEMORIES:\n${memCtx}\n` : ""}
Generate ONLY valid HCL Terraform. No markdown fences. No explanations. Only code.
DO NOT include provider, terraform, or variable blocks — they are already provided externally.
Available variables (do NOT redeclare): var.aws_region, var.aws_account_id, var.floci_endpoint.

MANDATORY RULES:
1. Always start with: resource "random_id" "suffix" { byte_length = 4 }
2. Append -\${random_id.suffix.hex} to ALL resource name strings (S3 buckets, Lambda functions, IAM roles, API Gateways, DynamoDB tables).
3. Lambda zip: use data "archive_file" with inline source — NEVER reference external files.
4. API Gateway integration type for Lambda = "AWS_PROXY" (not "LAMBDA").
5. API Gateway REST resource types: aws_api_gateway_rest_api, aws_api_gateway_resource, aws_api_gateway_method, aws_api_gateway_integration, aws_api_gateway_deployment.

REFERENCE TEMPLATE (adapt as needed):
resource "random_id" "suffix" { byte_length = 4 }

data "archive_file" "fn_zip" {
  type = "zip"; output_path = "\${path.module}/fn.zip"
  source { content = "exports.handler = async (e) => ({ statusCode: 200, body: 'ok' });"; filename = "index.js" }
}

resource "aws_iam_role" "fn_role" {
  name = "fn-role-\${random_id.suffix.hex}"
  assume_role_policy = jsonencode({ Version="2012-10-17", Statement=[{ Effect="Allow", Principal={ Service="lambda.amazonaws.com" }, Action="sts:AssumeRole" }] })
}

resource "aws_lambda_function" "fn" {
  function_name = "my-fn-\${random_id.suffix.hex}"
  filename      = data.archive_file.fn_zip.output_path
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  role          = aws_iam_role.fn_role.arn
}

resource "aws_api_gateway_rest_api" "api" { name = "my-api-\${random_id.suffix.hex}" }
resource "aws_api_gateway_resource" "res" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "posts"
}
resource "aws_api_gateway_method" "meth" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.res.id
  http_method   = "ANY"
  authorization = "NONE"
}
resource "aws_api_gateway_integration" "integ" {
  rest_api_id             = aws_api_gateway_rest_api.api.id
  resource_id             = aws_api_gateway_resource.res.id
  http_method             = aws_api_gateway_method.meth.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "arn:aws:apigateway:\${var.aws_region}:lambda:path/2015-03-31/functions/\${aws_lambda_function.fn.arn}/invocations"
}
resource "aws_api_gateway_deployment" "dep" {
  depends_on  = [aws_api_gateway_integration.integ]
  rest_api_id = aws_api_gateway_rest_api.api.id
  stage_name  = "prod"
}` },
        { role: "user", content: `Generate Terraform for:\n${reqText}` },
      ],
    });

    const code = (response.choices[0].message.content ?? "") as string;
    const lineCount = code.split("\n").length;
    const resourceCount = (code.match(/^resource\s+/gm) ?? []).length;

    await addChatMessage(this.pool, taskId, "FORGE", "agent",
      `Terraform configuration complete.\n\n**${resourceCount} resource${resourceCount !== 1 ? "s" : ""} defined** across ${lineCount} lines.\n\nSubmitting to admin for plan review before deployment.`
    );

    const services = requirements.services?.join("+") ?? "infra";
    await this.brain.encodeSkill({
      skill_name: `${services} pattern`,
      description: `Successfully generated Terraform for: ${requirements.raw_summary ?? services}`,
      procedure: code.slice(0, 500),
      keywords: requirements.services ?? [],
    });

    setAgentStatus("FORGE", "idle");
    return { code, memoryStats: await this.brain.getStats() };
  }

  async fixTerraform(code: string, errors: string, taskId: string): Promise<string> {
    setAgentStatus("FORGE", "working", taskId, "Fixing Terraform errors…");
    await addChatMessage(this.pool, taskId, "FORGE", "agent",
      `Terraform plan failed. Analyzing errors and applying fixes…\n\n\`\`\`\n${errors.slice(0, 600)}\n\`\`\``
    );

    const response = await groqClient.chat.completions.create({
      model: this.soul.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: `You are FORGE. Fix the Terraform code based on the errors. Return ONLY corrected HCL. No markdown, no explanations.
Rules: DO NOT add provider/terraform/variable blocks. Available vars: var.aws_region, var.aws_account_id, var.floci_endpoint.
API Gateway integration type for Lambda = "AWS_PROXY". Lambda needs: function_name, filename, handler, runtime, role.
All resource names must be unique strings (use random_id.suffix.hex suffix if not already present).` },
        { role: "user", content: `Fix this Terraform code:\n\n${code}\n\nErrors:\n${errors}` },
      ],
    });

    const fixed = (response.choices[0].message.content ?? "") as string;
    await addChatMessage(this.pool, taskId, "FORGE", "agent", "Fixes applied. Retrying plan…");
    setAgentStatus("FORGE", "idle");
    return fixed;
  }
}

// ──────────────────────────────────────────
// SAGE — Validation Specialist
// ──────────────────────────────────────────
export class SAGE {
  readonly soul = SOULS.SAGE;
  private brain: AgentBrain;

  constructor(private pool: Pool) {
    this.brain = new AgentBrain("SAGE", pool);
  }

  async init() {
    await this.brain.seedKnowledge(
      [
        { category: "validation_rule", fact: "DynamoDB tables require partition key to be defined as an attribute.", keywords: ["dynamodb", "partition", "key"] },
        { category: "validation_rule", fact: "Lambda functions require an execution role ARN to be set.", keywords: ["lambda", "role", "execution"] },
        { category: "validation_rule", fact: "S3 buckets are regional resources; verify region matches requirements.", keywords: ["s3", "region"] },
        { category: "floci_limit",     fact: "Floci DynamoDB does not support multi-region replication.", keywords: ["dynamodb", "replication", "region"] },
        { category: "security_rule",   fact: "Avoid wildcards (*) in IAM policies; use least-privilege.", keywords: ["iam", "policy", "wildcard"] },
      ],
      []
    );
  }

  async validate(requirements: any, tfState: any, applyOutput: string, taskId: string): Promise<any> {
    setAgentStatus("SAGE", "thinking", taskId, "Scrutinizing the deployment…");
    await addChatMessage(this.pool, taskId, "SAGE", "agent",
      "Infrastructure deployed. Now I scrutinize — trust nothing until verified. Checking every resource against requirements…"
    );

    const memCtx = await this.brain.getMemoryContext(JSON.stringify(requirements));

    const response = await groqClient.chat.completions.create({
      model: this.soul.model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `You are SAGE — ${this.soul.full}.
Soul: ${this.soul.soul}

${memCtx ? `MY MEMORIES:\n${memCtx}\n` : ""}

Validate deployed infrastructure against requirements. Be thorough. Be skeptical.
Return ONLY valid JSON:
{ "passed": boolean, "issues": string[], "warnings": string[], "summary": string }` },
        {
          role: "user",
          content: `Requirements:\n${JSON.stringify(requirements)}\n\nTerraform State:\n${JSON.stringify(tfState, null, 2).slice(0,2000)}\n\nApply Output:\n${applyOutput.slice(0,1000)}`,
        },
      ],
    });

    const text = (response.choices[0].message.content ?? "") as string;
    const match = text.match(/\{[\s\S]*\}/);
    let result: any = { passed: false, issues: [text], warnings: [], summary: "Parse error" };
    try { if (match) result = JSON.parse(match[0]); } catch {}

    const icon = result.passed ? "✅" : "⚠️";
    const issueLines = (result.issues ?? []).length
      ? `\n\n**Issues:**\n${(result.issues as string[]).map((i: string) => `- ${i}`).join("\n")}`
      : "";
    const warnLines = (result.warnings ?? []).length
      ? `\n\n**Warnings:**\n${(result.warnings as string[]).map((w: string) => `- ${w}`).join("\n")}`
      : "";
    await addChatMessage(this.pool, taskId, "SAGE", "agent",
      `${icon} Validation ${result.passed ? "passed" : "failed"}.\n\n${result.summary}${issueLines}${warnLines}\n\nPassing to SCOUT for capability gap analysis.`
    );

    await this.brain.learnFact({
      category: "validation_outcome",
      fact: `Validation ${result.passed ? "passed" : "failed"}: ${result.summary}`,
      keywords: requirements.services ?? [],
    });

    setAgentStatus("SAGE", "idle");
    return { ...result, memoryStats: await this.brain.getStats() };
  }
}

// ──────────────────────────────────────────
// SCOUT — Gap Detection Specialist
// ──────────────────────────────────────────
export class SCOUT {
  readonly soul = SOULS.SCOUT;
  private brain: AgentBrain;

  constructor(private pool: Pool) {
    this.brain = new AgentBrain("SCOUT", pool);
  }

  async init() {
    await this.brain.seedKnowledge(
      [
        { category: "known_gap", fact: "RDS/Aurora is not available in Floci — suggest DynamoDB as alternative.", keywords: ["rds", "aurora", "database"] },
        { category: "known_gap", fact: "ElastiCache/Redis is not available in Floci — suggest application-level caching.", keywords: ["elasticache", "redis", "cache"] },
        { category: "known_gap", fact: "Managed Kubernetes (EKS/GKE/AKS) is not available in Floci.", keywords: ["kubernetes", "eks", "aks", "gke"] },
        { category: "known_gap", fact: "CloudFront CDN is not available in Floci.", keywords: ["cloudfront", "cdn"] },
        { category: "frontier",  fact: "Most-requested gap: managed relational database (RDS).", keywords: ["rds", "relational", "sql"] },
      ],
      []
    );
  }

  async detectGaps(requirements: any, terraformCode: string, taskId: string): Promise<any[]> {
    setAgentStatus("SCOUT", "thinking", taskId, "Scanning the frontier for capability gaps…");
    await addChatMessage(this.pool, taskId, "SCOUT", "agent",
      "Scanning the frontier — checking what you asked for against what Floci can actually deliver…"
    );

    const memCtx = await this.brain.getMemoryContext(JSON.stringify(requirements));

    const response = await groqClient.chat.completions.create({
      model: this.soul.model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `You are SCOUT — ${this.soul.full}.
Soul: ${this.soul.soul}

${memCtx ? `MY MEMORIES:\n${memCtx}\n` : ""}

FLOCI AVAILABLE: S3, DynamoDB, Lambda, EC2, IAM, SQS, SNS, CloudWatch, Secrets Manager.
NOT AVAILABLE: RDS, ElastiCache, Kubernetes, CloudFront, WAF, Kinesis, Step Functions.

Identify capability gaps between requirements and Floci.
Return ONLY a JSON array (empty if no gaps):
[{ "service": string, "feature": string, "severity": "critical"|"high"|"medium"|"low", "workaround": string }]` },
        { role: "user", content: `Requirements:\n${JSON.stringify(requirements)}\n\nTerraform:\n${terraformCode.slice(0,1000)}` },
      ],
    });

    const text = (response.choices[0].message.content ?? "") as string;
    const match = text.match(/\[[\s\S]*\]/);
    let gaps: any[] = [];
    try { if (match) gaps = JSON.parse(match[0]); } catch {}

    if (gaps.length === 0) {
      await addChatMessage(this.pool, taskId, "SCOUT", "agent",
        "✅ No capability gaps detected. Everything you requested is fully supported by Floci. Mission complete."
      );
    } else {
      const gapLines = gaps.map((g: any) =>
        `- **${g.service}** — ${g.feature} *(${g.severity})* → ${g.workaround}`
      ).join("\n");
      await addChatMessage(this.pool, taskId, "SCOUT", "agent",
        `🚩 Found ${gaps.length} capability gap${gaps.length !== 1 ? "s" : ""} — flagged to admin:\n\n${gapLines}`
      );
    }

    for (const gap of gaps) {
      await this.brain.storeEpisode({
        episode_type: "gap_discovered",
        context: `User requested ${gap.service} — ${gap.feature}`,
        outcome: `Not available. Severity: ${gap.severity}. Workaround: ${gap.workaround}`,
        keywords: [gap.service.toLowerCase(), gap.feature.toLowerCase()],
      });
    }

    setAgentStatus("SCOUT", "idle");
    return gaps;
  }

  async getStats(): Promise<MemoryStats> { return this.brain.getStats(); }
}
