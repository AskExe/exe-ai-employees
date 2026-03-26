/**
 * Hybrid search: vector similarity + FTS5 full-text search with RRF reranking.
 *
 * With SQLCipher, all text is plaintext in RAM — FTS5 works natively.
 * lightweightSearch uses FTS5 MATCH queries (replaces JS keyword matching).
 * hybridSearch runs BOTH vector + FTS, merges with Reciprocal Rank Fusion.
 *
 * @module hybrid-search
 */

import { searchMemories, type SearchOptions } from "./store.js";
import type { MemoryRecord } from "../types/memory.js";
import { getClient } from "./turso.js";

/**
 * RRF constant — standard value from the original RRF paper.
 * Higher values reduce the influence of high-ranked items.
 */
const RRF_K = 60;

/**
 * True hybrid search: runs BOTH FTS5 and vector search, merges with RRF.
 *
 * Strategy:
 * 1. Run FTS5 search → results ranked by BM25
 * 2. Run vector search → results ranked by cosine distance
 * 3. Merge with Reciprocal Rank Fusion: score = Σ 1/(k + rank)
 * 4. Return top N by RRF score
 *
 * Graceful degradation:
 * - Embed daemon down → FTS-only (no vector search attempted)
 * - Config searchMode=fts → FTS-only (skip embedding model entirely)
 * - No FTS terms → vector-only + recent records fallback
 * - Neither returns results → empty
 */
export async function hybridSearch(
  queryText: string,
  agentId: string,
  options?: SearchOptions,
): Promise<MemoryRecord[]> {
  // Respect searchMode config — if "fts", skip embedding model entirely
  const { loadConfig } = await import("./config.js");
  const config = await loadConfig();
  if (config.searchMode === "fts") {
    return lightweightSearch(queryText, agentId, options);
  }

  const limit = options?.limit ?? 10;
  // Fetch more candidates from each source for better RRF merging
  const fetchLimit = Math.max(limit * 3, 30);
  const fetchOptions = { ...options, limit: fetchLimit };

  // Try to embed the query — non-blocking failure
  let queryVector: number[] | null = null;
  try {
    const { embed } = await import("./embedder.js");
    queryVector = await embed(queryText);
  } catch {
    process.stderr.write("[hybrid-search] Embed daemon unavailable — FTS-only mode\n");
  }

  // Run both searches in parallel
  const [ftsResults, vectorResults] = await Promise.all([
    lightweightSearch(queryText, agentId, fetchOptions),
    queryVector
      ? searchMemories(queryVector, agentId, fetchOptions)
      : Promise.resolve([] as MemoryRecord[]),
  ]);

  // If only one source returned results, return that directly
  if (vectorResults.length === 0 && ftsResults.length === 0) {
    return [];
  }
  if (vectorResults.length === 0) {
    return ftsResults.slice(0, limit);
  }
  if (ftsResults.length === 0) {
    return vectorResults.slice(0, limit);
  }

  // Merge with Reciprocal Rank Fusion
  return rrfMerge(ftsResults, vectorResults, limit);
}

/**
 * Reciprocal Rank Fusion: merge two ranked lists into one.
 *
 * For each document, RRF score = Σ 1/(k + rank_in_list)
 * where rank is 1-based position in each list.
 * Documents appearing in both lists get boosted.
 */
export function rrfMerge(
  listA: MemoryRecord[],
  listB: MemoryRecord[],
  limit: number,
  k: number = RRF_K,
): MemoryRecord[] {
  const scores = new Map<string, { score: number; record: MemoryRecord }>();

  for (let i = 0; i < listA.length; i++) {
    const rec = listA[i]!;
    const entry = scores.get(rec.id) ?? { score: 0, record: rec };
    entry.score += 1 / (k + i + 1); // rank is 1-based
    scores.set(rec.id, entry);
  }

  for (let i = 0; i < listB.length; i++) {
    const rec = listB[i]!;
    const entry = scores.get(rec.id) ?? { score: 0, record: rec };
    entry.score += 1 / (k + i + 1);
    scores.set(rec.id, entry);
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.record);
}

/**
 * Lightweight text-only search using FTS5 MATCH queries.
 *
 * Strategy: use FTS5 full-text index joined with memories table,
 * filtered by agent_id in SQL. No embedding model needed.
 */
export async function lightweightSearch(
  queryText: string,
  agentId: string,
  options?: SearchOptions,
): Promise<MemoryRecord[]> {
  const client = getClient();
  const limit = options?.limit ?? 5;

  // Tokenize and clean query terms for FTS5
  const terms = queryText
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.replace(/[^a-z0-9_]/g, "")) // strip non-alphanumeric chars (commas, quotes, etc.)
    .filter((t) => t.length >= 3); // re-filter after stripping

  if (terms.length === 0) {
    // No meaningful terms — fall back to recent records by timestamp
    return recentRecords(agentId, options, limit);
  }

  // Build FTS5 MATCH expression with prefix matching and smart joining.
  // Prefix: "behavior*" matches "behavior", "behavioral", "behaviors".
  // Join strategy: AND first for precision (3+ terms), fall back to OR for recall.
  const prefixTerms = terms.map((t) => `${t}*`);
  const useAnd = terms.length >= 3;
  const matchExpr = useAnd
    ? prefixTerms.join(" AND ")
    : prefixTerms.join(" OR ");

  const results = await ftsQuery(client, matchExpr, agentId, options, limit);

  // AND may be too strict — fall back to OR if too few results
  if (useAnd && results.length < limit) {
    const orExpr = prefixTerms.join(" OR ");
    const orResults = await ftsQuery(client, orExpr, agentId, options, limit);
    // Merge: AND results first (higher precision), then OR results to fill
    const seen = new Set(results.map((r) => r.id));
    for (const r of orResults) {
      if (!seen.has(r.id) && results.length < limit) {
        results.push(r);
        seen.add(r.id);
      }
    }
  }

  return results;
}

/**
 * Execute an FTS5 MATCH query with filters, returning MemoryRecord[].
 */
async function ftsQuery(
  client: ReturnType<typeof getClient>,
  matchExpr: string,
  agentId: string,
  options: SearchOptions | undefined,
  limit: number,
): Promise<MemoryRecord[]> {
  let sql = `SELECT m.id, m.agent_id, m.agent_role, m.session_id, m.timestamp,
                    m.tool_name, m.project_name,
                    m.has_error, m.raw_text, m.vector
             FROM memories m
             JOIN memories_fts fts ON m.rowid = fts.rowid
             WHERE memories_fts MATCH ?
               AND m.agent_id = ?`;
  const args: (string | number)[] = [matchExpr, agentId];

  if (options?.projectName) {
    sql += ` AND m.project_name = ?`;
    args.push(options.projectName);
  }

  if (options?.toolName) {
    sql += ` AND m.tool_name = ?`;
    args.push(options.toolName);
  }

  if (options?.hasError !== undefined) {
    sql += ` AND m.has_error = ?`;
    args.push(options.hasError ? 1 : 0);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  args.push(limit);

  const result = await client.execute({ sql, args });

  return result.rows.map((row) => ({
    id: row.id as string,
    agent_id: row.agent_id as string,
    agent_role: row.agent_role as string,
    session_id: row.session_id as string,
    timestamp: row.timestamp as string,
    tool_name: row.tool_name as string,
    project_name: row.project_name as string,
    has_error: (row.has_error as number) === 1,
    raw_text: row.raw_text as string,
    vector: row.vector == null
      ? []
      : Array.isArray(row.vector)
        ? row.vector
        : Array.from(row.vector as unknown as Float32Array),
  }));
}

/**
 * Fallback: fetch recent records when no FTS query terms are available.
 */
async function recentRecords(
  agentId: string,
  options: SearchOptions | undefined,
  limit: number,
): Promise<MemoryRecord[]> {
  const client = getClient();

  let sql = `SELECT id, agent_id, agent_role, session_id, timestamp,
                    tool_name, project_name,
                    has_error, raw_text, vector
             FROM memories
             WHERE agent_id = ?`;
  const args: (string | number)[] = [agentId];

  if (options?.projectName) {
    sql += ` AND project_name = ?`;
    args.push(options.projectName);
  }

  if (options?.toolName) {
    sql += ` AND tool_name = ?`;
    args.push(options.toolName);
  }

  if (options?.hasError !== undefined) {
    sql += ` AND has_error = ?`;
    args.push(options.hasError ? 1 : 0);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  args.push(limit);

  const result = await client.execute({ sql, args });

  return result.rows.map((row) => ({
    id: row.id as string,
    agent_id: row.agent_id as string,
    agent_role: row.agent_role as string,
    session_id: row.session_id as string,
    timestamp: row.timestamp as string,
    tool_name: row.tool_name as string,
    project_name: row.project_name as string,
    has_error: (row.has_error as number) === 1,
    raw_text: row.raw_text as string,
    vector: row.vector == null
      ? []
      : Array.isArray(row.vector)
        ? row.vector
        : Array.from(row.vector as unknown as Float32Array),
  }));
}
