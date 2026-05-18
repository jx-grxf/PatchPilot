import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getPatchPilotConfigDir } from "./env.js";

export type MemoryEntry = {
  id: number;
  workspace: string;
  content: string;
  tags: string[];
  createdAt: string;
};

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(getPatchPilotConfigDir(), "memory.sqlite")) {
    mkdirSync(path.dirname(dbPath), {
      recursive: true,
      mode: 0o700
    });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        term_vector TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    `);
  }

  remember(workspace: string, content: string, tags: string[] = []): MemoryEntry {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      throw new Error("memory content cannot be empty.");
    }

    const createdAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO memories (workspace, content, tags, term_vector, created_at) VALUES (?, ?, ?, ?, ?)").run(
      path.resolve(workspace),
      normalizedContent,
      JSON.stringify(cleanTags(tags)),
      JSON.stringify(buildTermVector(normalizedContent)),
      createdAt
    );

    return {
      id: Number(result.lastInsertRowid),
      workspace: path.resolve(workspace),
      content: normalizedContent,
      tags: cleanTags(tags),
      createdAt
    };
  }

  search(workspace: string, query: string, limit = 8): Array<MemoryEntry & { score: number }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const queryVector = buildTermVector(normalizedQuery);
    const rows = this.db
      .prepare("SELECT id, workspace, content, tags, term_vector, created_at FROM memories WHERE workspace = ? ORDER BY created_at DESC LIMIT 120")
      .all(path.resolve(workspace)) as Array<{
      id: number;
      workspace: string;
      content: string;
      tags: string;
      term_vector: string;
      created_at: string;
    }>;

    return rows
      .map((row) => ({
        id: row.id,
        workspace: row.workspace,
        content: row.content,
        tags: readTags(row.tags),
        createdAt: row.created_at,
        score: scoreTermVectors(queryVector, readTermVector(row.term_vector))
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  close(): void {
    this.db.close();
  }
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function readTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

function readTermVector(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function buildTermVector(value: string): Record<string, number> {
  const terms = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3);
  const vector: Record<string, number> = {};
  for (const term of terms) {
    vector[term] = (vector[term] ?? 0) + 1;
  }
  return vector;
}

function scoreTermVectors(query: Record<string, number>, candidate: Record<string, number>): number {
  let score = 0;
  for (const [term, weight] of Object.entries(query)) {
    score += Math.min(weight, candidate[term] ?? 0);
  }
  return score;
}
