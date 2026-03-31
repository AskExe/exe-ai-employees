/**
 * Embedding API — delegates to the exe-daemon via Unix socket.
 *
 * The daemon holds the single model instance in GPU memory.
 * This module provides the same public API as before (embed, getEmbedder,
 * disposeEmbedder) but routes through the daemon client instead of
 * loading the model in-process.
 *
 * embedDirect() is the escape hatch for setup-wizard model validation
 * where the daemon may not exist yet.
 *
 * @module embedder
 */

import { EMBEDDING_DIM } from "../types/memory.js";
import {
  connectEmbedDaemon,
  embedViaClient,
  disconnectClient,
} from "./exe-daemon-client.js";

/**
 * Connect to the embedding daemon (replaces pre-warming the model).
 * Spawns the daemon if it's not running.
 * @throws Error if daemon cannot be reached after retries
 */
export async function getEmbedder(): Promise<void> {
  const ok = await connectEmbedDaemon();
  if (!ok) {
    throw new Error(
      "Could not connect to embedding daemon. Ensure the model is installed (run /exe-setup).",
    );
  }
}

/**
 * Embed a text string into a 1024-dimensional float vector.
 * Routes through the daemon for shared GPU access.
 *
 * Priority is determined by EXE_EMBED_PRIORITY env var:
 *   - "low" for ingest workers (fire-and-forget)
 *   - "high" (default) for MCP tools and hooks (Claude is waiting)
 *
 * @throws Error if daemon unavailable or dimension mismatch
 */
export async function embed(text: string): Promise<number[]> {
  const priority = (process.env.EXE_EMBED_PRIORITY === "low" ? "low" : "high") as "high" | "low";
  const vector = await embedViaClient(text, priority);

  if (!vector) {
    throw new Error(
      "Embedding failed: daemon unavailable. Run /exe-setup to verify model installation.",
    );
  }

  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}. ` +
      `Ensure the correct Jina v5-small Q4_K_M GGUF model is installed.`,
    );
  }

  return vector;
}

/**
 * Disconnect from the embedding daemon.
 * Does NOT shut down the daemon — other processes may be using it.
 */
export async function disposeEmbedder(): Promise<void> {
  disconnectClient();
}

// ---------------------------------------------------------------------------
// Direct model loading (setup wizard only)
// ---------------------------------------------------------------------------

/**
 * Load the model directly in this process and embed text.
 * ONLY used by validateModel() in setup-wizard.ts where the daemon
 * may not exist yet during initial setup.
 *
 * Loads the model, embeds, and disposes immediately.
 */
export async function embedDirect(text: string): Promise<number[]> {
  const llamaCpp = await import("node-llama-cpp");
  const { MODELS_DIR } = await import("./config.js");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");

  const modelPath = path.join(MODELS_DIR, "jina-embeddings-v5-small-q4_k_m.gguf");
  if (!existsSync(modelPath)) {
    throw new Error(`Embedding model not found at ${modelPath}. Run '/exe-setup' to download it.`);
  }

  const llama = await llamaCpp.getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext();

  try {
    const embedding = await context.getEmbeddingFor(text);
    const vector = Array.from(embedding.vector);
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}.`,
      );
    }
    return vector;
  } finally {
    await context.dispose();
    await model.dispose();
  }
}
