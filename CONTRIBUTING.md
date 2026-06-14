# Contributing to FLOCI NEXUS

Thank you for considering a contribution. The project is small and focused — please read this before opening a PR.

## What belongs here

- Bug fixes in the agent pipeline, memory system, or API
- New Terraform patterns for FORGE's seed knowledge
- Improvements to the Ebbinghaus memory decay model
- New API endpoints backed by the existing DB schema
- Documentation improvements

## What does not belong here

- Switching the AI provider (Groq is intentional — free tier, fast inference)
- Switching the embedding model (nomic-embed-text is intentional — runs locally, 274 MB)
- Adding heavy frameworks (LangChain, LangGraph) to the agent layer
- UI changes (the React frontend lives in `floci-ui`, a separate repo)

## Getting started

```bash
git clone https://github.com/your-org/floci-nexus
cd floci-nexus
cp .env.example .env   # fill in GROQ_API_KEY
npm install
```

Follow the setup in the README to get PostgreSQL and Ollama running, then:

```bash
npm run dev
```

## Code style

- TypeScript strict mode is off intentionally — avoid adding complex type gymnastics
- No comments explaining *what* code does; only comment *why* when the reason is non-obvious
- No console.log spam — use the existing pipeline log format `[runId] message`
- Keep the agent classes (ARIA, FORGE, SAGE, SCOUT) single-responsibility

## Adding a new Terraform pattern to FORGE

Open `src/agents.ts` → `FORGE.init()` and add to either the `facts` or `skills` array:

```typescript
// A fact: a rule FORGE must know
{ category: "terraform_rule", fact: "Your rule here.", keywords: ["keyword1"] },

// A skill: a concrete multi-step pattern
{
  skill_name: "Pattern name",
  description: "One sentence description",
  procedure: "Step 1: ... Step 2: ...",
  keywords: ["keyword1", "keyword2"],
},
```

Seeds only run when the agent has zero existing memories, so they won't overwrite a running instance. Test by clearing the `semantic_memories` and `procedural_memories` tables for `FORGE`.

## Submitting a PR

1. Fork → branch from `main`
2. Run `npm run typecheck` — must pass with zero errors
3. Test the pipeline end-to-end with `AUTO_APPROVE=true`
4. Keep PRs focused — one concern per PR
5. Write a clear PR description explaining what changed and why

## Database schema changes

If your change requires a schema migration:

1. Add the migration SQL at the bottom of `schema.sql` inside a comment block labelled with the date
2. Document any manual `CREATE EXTENSION` steps needed (e.g. new extensions)
3. Note whether it requires a server restart or backfill

## Reporting bugs

Open a GitHub issue with:
- Node.js version (`node --version`)
- Groq model used (from `src/agents.ts`)
- The full error output from the server log
- The user message that triggered the failure
