import { Pool } from "pg";

// ──────────────────────────────────────────
// Decay rates per memory type (per hour)
// Inspired by Ebbinghaus forgetting curve
// ──────────────────────────────────────────
const DECAY = {
  episodic:   0.985, // ~13% per day  — vivid but fades
  semantic:   0.998, // ~2% per day   — knowledge persists
  procedural: 0.992, // ~8% per day   — skills need practice
};

const BOOST = {
  episodic:   0.12,
  semantic:   0.05,
  procedural: 0.18,  // skills strengthen most when used
};

const ARCHIVE_THRESHOLD = 0.07;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// ─── Ollama embedding (768-dim via nomic-embed-text) ───────────────────────

async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embedding: number[] };
    return data.embedding ?? null;
  } catch {
    return null;
  }
}

// Format a float array as a pgvector literal: [0.1,0.2,...]
function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Jaccard fallback for when embeddings are missing or Ollama is down
function jaccard(a: string, b: string): number {
  const stopwords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","it","this","that","be","was","are","with","as","by","not"]);
  const tok = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w)));
  const s1 = tok(a), s2 = tok(b);
  const inter = [...s1].filter(w => s2.has(w)).length;
  const union = new Set([...s1, ...s2]).size;
  return union === 0 ? 0 : inter / union;
}

export interface Episode {
  id?: string;
  episode_type: string;
  context: string;
  outcome: string;
  keywords?: string[];
  strength?: number;
  access_count?: number;
}

export interface Fact {
  id?: string;
  category: string;
  fact: string;
  confidence?: number;
  keywords?: string[];
  strength?: number;
}

export interface Skill {
  id?: string;
  skill_name: string;
  description: string;
  procedure: string;
  keywords?: string[];
  strength?: number;
  success_count?: number;
}

export interface MemoryStats {
  episodic:   { count: number; avg_strength: number };
  semantic:   { count: number; avg_strength: number };
  procedural: { count: number; avg_strength: number };
}

export class AgentBrain {
  constructor(private agentName: string, private pool: Pool) {}

  // ─────────── EPISODIC ───────────

  async storeEpisode(ep: Episode): Promise<void> {
    const kw = this.extractKeywords(ep.context + " " + ep.outcome);
    const embedding = await embedText(ep.context + " " + ep.outcome);
    await this.pool.query(
      `INSERT INTO episodic_memories (agent_name, episode_type, context, outcome, keywords, embedding)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [this.agentName, ep.episode_type, ep.context, ep.outcome, kw,
       embedding ? vecLiteral(embedding) : null]
    );
  }

  async recallEpisodes(query: string, limit = 3): Promise<Episode[]> {
    const qvec = await embedText(query);
    let results: (Episode & { id: string })[];

    if (qvec) {
      // Vector similarity — cosine distance (lower = more similar)
      const rows = await this.pool.query<Episode & { id: string }>(
        `SELECT * FROM episodic_memories
         WHERE agent_name=$1 AND strength > $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector
         LIMIT $4`,
        [this.agentName, ARCHIVE_THRESHOLD, vecLiteral(qvec), limit]
      );
      if (rows.rowCount && rows.rowCount > 0) {
        results = rows.rows;
      } else {
        results = await this._jaccardEpisodes(query, limit);
      }
    } else {
      results = await this._jaccardEpisodes(query, limit);
    }

    for (const r of results) {
      await this.pool.query(
        `UPDATE episodic_memories SET strength=LEAST(1.0, strength+$1), access_count=access_count+1, last_accessed=NOW() WHERE id=$2`,
        [BOOST.episodic, r.id]
      );
    }
    return results;
  }

  private async _jaccardEpisodes(query: string, limit: number): Promise<(Episode & { id: string })[]> {
    const rows = await this.pool.query<Episode & { id: string }>(
      `SELECT * FROM episodic_memories WHERE agent_name=$1 AND strength > $2 ORDER BY strength DESC LIMIT 20`,
      [this.agentName, ARCHIVE_THRESHOLD]
    );
    return rows.rows
      .map(r => ({ r, score: jaccard(query, r.context + " " + r.outcome) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.r);
  }

  // ─────────── SEMANTIC ───────────

  async learnFact(fact: Fact): Promise<void> {
    const kw = this.extractKeywords(fact.fact);
    const embedding = await embedText(fact.fact + " " + fact.category);
    await this.pool.query(
      `INSERT INTO semantic_memories (agent_name, category, fact, keywords, embedding)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [this.agentName, fact.category, fact.fact, kw,
       embedding ? vecLiteral(embedding) : null]
    );
  }

  async queryFacts(query: string, limit = 5): Promise<Fact[]> {
    const qvec = await embedText(query);
    let results: (Fact & { id: string })[];

    if (qvec) {
      const rows = await this.pool.query<Fact & { id: string }>(
        `SELECT * FROM semantic_memories
         WHERE agent_name=$1 AND strength > $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector
         LIMIT $4`,
        [this.agentName, ARCHIVE_THRESHOLD, vecLiteral(qvec), limit]
      );
      if (rows.rowCount && rows.rowCount > 0) {
        results = rows.rows;
      } else {
        results = await this._jaccardFacts(query, limit);
      }
    } else {
      results = await this._jaccardFacts(query, limit);
    }

    for (const r of results) {
      await this.pool.query(
        `UPDATE semantic_memories SET strength=LEAST(1.0, strength+$1), last_accessed=NOW() WHERE id=$2`,
        [BOOST.semantic, r.id]
      );
    }
    return results;
  }

  private async _jaccardFacts(query: string, limit: number): Promise<(Fact & { id: string })[]> {
    const rows = await this.pool.query<Fact & { id: string }>(
      `SELECT * FROM semantic_memories WHERE agent_name=$1 AND strength > $2 ORDER BY strength DESC LIMIT 30`,
      [this.agentName, ARCHIVE_THRESHOLD]
    );
    return rows.rows
      .map(r => ({ r, score: jaccard(query, r.fact + " " + r.category) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.r);
  }

  // ─────────── PROCEDURAL ───────────

  async encodeSkill(skill: Skill): Promise<void> {
    const kw = this.extractKeywords(skill.skill_name + " " + skill.description);
    const embedding = await embedText(skill.skill_name + " " + skill.description + " " + skill.procedure);
    await this.pool.query(
      `INSERT INTO procedural_memories (agent_name, skill_name, description, procedure, keywords, embedding)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [this.agentName, skill.skill_name, skill.description, skill.procedure, kw,
       embedding ? vecLiteral(embedding) : null]
    );
  }

  async recallSkills(query: string, limit = 3): Promise<Skill[]> {
    const qvec = await embedText(query);
    let results: (Skill & { id: string })[];

    if (qvec) {
      const rows = await this.pool.query<Skill & { id: string }>(
        `SELECT * FROM procedural_memories
         WHERE agent_name=$1 AND strength > $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector
         LIMIT $4`,
        [this.agentName, ARCHIVE_THRESHOLD, vecLiteral(qvec), limit]
      );
      if (rows.rowCount && rows.rowCount > 0) {
        results = rows.rows;
      } else {
        results = await this._jaccardSkills(query, limit);
      }
    } else {
      results = await this._jaccardSkills(query, limit);
    }

    for (const r of results) {
      await this.pool.query(
        `UPDATE procedural_memories SET strength=LEAST(1.0, strength+$1), last_used=NOW() WHERE id=$2`,
        [BOOST.procedural, r.id]
      );
    }
    return results;
  }

  private async _jaccardSkills(query: string, limit: number): Promise<(Skill & { id: string })[]> {
    const rows = await this.pool.query<Skill & { id: string }>(
      `SELECT * FROM procedural_memories WHERE agent_name=$1 AND strength > $2 ORDER BY strength DESC LIMIT 20`,
      [this.agentName, ARCHIVE_THRESHOLD]
    );
    return rows.rows
      .map(r => ({ r, score: jaccard(query, r.skill_name + " " + r.description) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.r);
  }

  async reinforceSkill(skillId: string, success: boolean): Promise<void> {
    if (success) {
      await this.pool.query(
        `UPDATE procedural_memories SET strength=LEAST(1.0, strength+0.2), success_count=success_count+1 WHERE id=$1`,
        [skillId]
      );
    } else {
      await this.pool.query(
        `UPDATE procedural_memories SET strength=GREATEST(0, strength-0.1), failure_count=failure_count+1 WHERE id=$1`,
        [skillId]
      );
    }
  }

  // ─────────── CONTEXT BUILDER ───────────

  async getMemoryContext(taskContext: string): Promise<string> {
    const [episodes, facts, skills] = await Promise.all([
      this.recallEpisodes(taskContext),
      this.queryFacts(taskContext),
      this.recallSkills(taskContext),
    ]);

    const lines: string[] = [];

    if (skills.length) {
      lines.push("── PROCEDURAL MEMORY (skills I've mastered) ──");
      skills.forEach(s => lines.push(`• [${s.skill_name}] ${s.procedure}`));
    }
    if (facts.length) {
      lines.push("── SEMANTIC KNOWLEDGE (facts I know) ──");
      facts.forEach(f => lines.push(`• [${f.category}] ${f.fact}`));
    }
    if (episodes.length) {
      lines.push("── EPISODIC MEMORY (experiences I recall) ──");
      episodes.forEach(e => lines.push(`• [${e.episode_type}] ${e.context} → ${e.outcome}`));
    }

    return lines.length ? lines.join("\n") : "";
  }

  // ─────────── BACKFILL embeddings for existing memories ───────────

  async backfillEmbeddings(): Promise<{ episodic: number; semantic: number; procedural: number }> {
    const counts = { episodic: 0, semantic: 0, procedural: 0 };

    const episodes = await this.pool.query<{ id: string; context: string; outcome: string }>(
      `SELECT id, context, outcome FROM episodic_memories WHERE agent_name=$1 AND embedding IS NULL`,
      [this.agentName]
    );
    for (const r of episodes.rows) {
      const vec = await embedText(r.context + " " + r.outcome);
      if (vec) {
        await this.pool.query(
          `UPDATE episodic_memories SET embedding=$1::vector WHERE id=$2`,
          [vecLiteral(vec), r.id]
        );
        counts.episodic++;
      }
    }

    const facts = await this.pool.query<{ id: string; fact: string; category: string }>(
      `SELECT id, fact, category FROM semantic_memories WHERE agent_name=$1 AND embedding IS NULL`,
      [this.agentName]
    );
    for (const r of facts.rows) {
      const vec = await embedText(r.fact + " " + r.category);
      if (vec) {
        await this.pool.query(
          `UPDATE semantic_memories SET embedding=$1::vector WHERE id=$2`,
          [vecLiteral(vec), r.id]
        );
        counts.semantic++;
      }
    }

    const skills = await this.pool.query<{ id: string; skill_name: string; description: string; procedure: string }>(
      `SELECT id, skill_name, description, procedure FROM procedural_memories WHERE agent_name=$1 AND embedding IS NULL`,
      [this.agentName]
    );
    for (const r of skills.rows) {
      const vec = await embedText(r.skill_name + " " + r.description + " " + r.procedure);
      if (vec) {
        await this.pool.query(
          `UPDATE procedural_memories SET embedding=$1::vector WHERE id=$2`,
          [vecLiteral(vec), r.id]
        );
        counts.procedural++;
      }
    }

    return counts;
  }

  // ─────────── STATS ───────────

  async getStats(): Promise<MemoryStats> {
    const [e, s, p] = await Promise.all([
      this.pool.query<{ count: string; avg: string }>(
        `SELECT COUNT(*) as count, COALESCE(AVG(strength),0) as avg FROM episodic_memories WHERE agent_name=$1 AND strength > $2`,
        [this.agentName, ARCHIVE_THRESHOLD]
      ),
      this.pool.query<{ count: string; avg: string }>(
        `SELECT COUNT(*) as count, COALESCE(AVG(strength),0) as avg FROM semantic_memories WHERE agent_name=$1 AND strength > $2`,
        [this.agentName, ARCHIVE_THRESHOLD]
      ),
      this.pool.query<{ count: string; avg: string }>(
        `SELECT COUNT(*) as count, COALESCE(AVG(strength),0) as avg FROM procedural_memories WHERE agent_name=$1 AND strength > $2`,
        [this.agentName, ARCHIVE_THRESHOLD]
      ),
    ]);
    return {
      episodic:   { count: parseInt(e.rows[0].count), avg_strength: parseFloat(Number(e.rows[0].avg).toFixed(3)) },
      semantic:   { count: parseInt(s.rows[0].count), avg_strength: parseFloat(Number(s.rows[0].avg).toFixed(3)) },
      procedural: { count: parseInt(p.rows[0].count), avg_strength: parseFloat(Number(p.rows[0].avg).toFixed(3)) },
    };
  }

  // ─────────── DECAY (run periodically) ───────────

  static async runGlobalDecay(pool: Pool): Promise<void> {
    const tables = [
      { table: "episodic_memories",   rate: DECAY.episodic,   type: "episodic",   timeCol: "last_accessed" },
      { table: "semantic_memories",   rate: DECAY.semantic,   type: "semantic",   timeCol: "last_accessed" },
      { table: "procedural_memories", rate: DECAY.procedural, type: "procedural", timeCol: "last_used"     },
    ] as const;

    for (const { table, rate, type, timeCol } of tables) {
      await pool.query(
        `UPDATE ${table}
         SET strength = GREATEST(0, strength * POWER($1, EXTRACT(EPOCH FROM NOW()-${timeCol})/3600.0))
         WHERE strength > $2`,
        [rate, ARCHIVE_THRESHOLD]
      );

      const result = await pool.query<{ archived: string; decayed: string; avg_loss: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE strength <= $1) AS archived,
           COUNT(*) FILTER (WHERE strength > $1)  AS decayed,
           COALESCE(AVG(1.0 - strength), 0)       AS avg_loss
         FROM ${table}`,
        [ARCHIVE_THRESHOLD]
      );

      const agents = await pool.query<{ agent_name: string }>(
        `SELECT DISTINCT agent_name FROM ${table}`
      );

      for (const { agent_name } of agents.rows) {
        const row = result.rows[0];
        await pool.query(
          `INSERT INTO memory_decay_log (memory_type, agent_name, archived, decayed, avg_loss)
           VALUES ($1,$2,$3,$4,$5)`,
          [type, agent_name, parseInt(row.archived), parseInt(row.decayed), parseFloat(row.avg_loss)]
        );
      }
    }
  }

  // ─────────── SEED initial knowledge ───────────

  async seedKnowledge(facts: Omit<Fact, "id">[], skills: Omit<Skill, "id">[]): Promise<void> {
    const existing = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM semantic_memories WHERE agent_name=$1`,
      [this.agentName]
    );
    if (parseInt(existing.rows[0].cnt) > 0) return; // already seeded

    for (const f of facts) await this.learnFact(f);
    for (const s of skills) await this.encodeSkill(s);
  }

  private extractKeywords(text: string): string[] {
    const stopwords = new Set(["the","a","an","in","on","at","to","for","of","and","or","is","it","this","that","be","was","are","with","as","by","not","i","my","we","you"]);
    return [...new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w))
    )].slice(0, 20);
  }
}
