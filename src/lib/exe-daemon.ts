/**
 * Embedding daemon — single process that holds the GGUF model in GPU memory.
 *
 * All exe-mem processes (MCP servers, ingest workers, hooks, CLI commands)
 * connect to this daemon via Unix socket instead of each loading the model.
 *
 * Protocol: newline-delimited JSON (JSON-lines)
 *   Request:  {"id":"uuid","texts":["text"],"priority":"high"|"low"}\n
 *   Response: {"id":"uuid","vectors":[[0.1,...]]}\n
 *          or {"id":"uuid","error":"msg"}\n
 *
 * Lifecycle:
 *   - Spawned by exe-daemon-client on first connection attempt
 *   - Shuts down after 5 minutes of no connections + empty queues
 *   - PID file at ~/.exe-mem/exed.pid
 *   - Socket at ~/.exe-mem/exed.sock
 *
 * @module exe-daemon
 */

import net from "node:net";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { getLlama, type LlamaModel, type LlamaEmbeddingContext } from "node-llama-cpp";
import { MODELS_DIR, EXE_AI_DIR } from "./config.js";
import { EMBEDDING_DIM } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.EXE_EMBED_SOCK ?? path.join(EXE_AI_DIR, "exed.sock");
const PID_PATH = process.env.EXE_EMBED_PID ?? path.join(EXE_AI_DIR, "exed.pid");
const MODEL_FILE = "jina-embeddings-v5-small-q4_k_m.gguf";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — longer to avoid cold starts during active sessions

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmbedRequest {
  id: string;
  texts: string[];
  priority: "high" | "low";
  type?: "embed" | "health";
}

interface QueueEntry {
  request: EmbedRequest;
  socket: net.Socket;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _context: LlamaEmbeddingContext | null = null;
let _model: LlamaModel | null = null;
let _llama: Awaited<ReturnType<typeof getLlama>> | null = null;

const highQueue: QueueEntry[] = [];
const lowQueue: QueueEntry[] = [];
let _processing = false;
let _activeConnections = 0;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _requestsServed = 0;
const _startedAt = Date.now();

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

async function loadModel(): Promise<void> {
  const modelPath = path.join(MODELS_DIR, MODEL_FILE);
  if (!existsSync(modelPath)) {
    process.stderr.write(`[exed] FATAL: model not found at ${modelPath}\n`);
    process.exit(1);
  }

  process.stderr.write("[exed] Loading model...\n");
  _llama = await getLlama();
  _model = await _llama.loadModel({ modelPath });
  _context = await _model.createEmbeddingContext();
  process.stderr.write("[exed] Model loaded and ready.\n");
}

// ---------------------------------------------------------------------------
// Queue processing
// ---------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (_processing) return;
  _processing = true;

  try {
    while (highQueue.length > 0 || lowQueue.length > 0) {
      // Always drain HIGH first
      const entry = highQueue.shift() ?? lowQueue.shift();
      if (!entry) break;

      // Skip if client already disconnected
      if (entry.socket.destroyed) continue;

      try {
        const vectors: number[][] = [];
        for (const text of entry.request.texts) {
          const embedding = await _context!.getEmbeddingFor(text);
          const vector = Array.from(embedding.vector);
          if (vector.length !== EMBEDDING_DIM) {
            throw new Error(`Dimension mismatch: got ${vector.length}, expected ${EMBEDDING_DIM}`);
          }
          vectors.push(vector);
        }

        _requestsServed++;
        sendResponse(entry.socket, { id: entry.request.id, vectors });
      } catch (err) {
        sendResponse(entry.socket, {
          id: entry.request.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    _processing = false;
    checkIdle();
  }
}

function sendResponse(socket: net.Socket, data: { id: string; vectors?: number[][]; error?: string; health?: { status: string; uptime: number; requests_served: number } }): void {
  if (!socket.destroyed) {
    try {
      socket.write(JSON.stringify(data) + "\n");
    } catch {
      // Client gone — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

function resetIdleTimer(): void {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

function checkIdle(): void {
  if (_activeConnections === 0 && highQueue.length === 0 && lowQueue.length === 0) {
    resetIdleTimer();
    _idleTimer = setTimeout(() => {
      process.stderr.write("[exed] Idle timeout — shutting down.\n");
      void shutdown();
    }, IDLE_TIMEOUT_MS);
    _idleTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  resetIdleTimer();

  if (_context) {
    try { await _context.dispose(); } catch { /* best effort */ }
    _context = null;
  }
  if (_model) {
    try { await _model.dispose(); } catch { /* best effort */ }
    _model = null;
  }
  _llama = null;

  try { unlinkSync(SOCKET_PATH); } catch { /* may not exist */ }
  try { unlinkSync(PID_PATH); } catch { /* may not exist */ }

  process.stderr.write("[exed] Shutdown complete.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

async function handleHealthCheck(socket: net.Socket, requestId: string): Promise<void> {
  const healthy = _context !== null && _model !== null;
  let testOk = false;
  if (healthy) {
    try {
      const testEmbed = await _context!.getEmbeddingFor("health check");
      testOk = Array.from(testEmbed.vector).length === EMBEDDING_DIM;
    } catch {
      testOk = false;
    }
  }
  sendResponse(socket, {
    id: requestId,
    ...(healthy && testOk
      ? {
          health: {
            status: "ok",
            uptime: Math.floor((Date.now() - _startedAt) / 1000),
            requests_served: _requestsServed,
          },
        }
      : { error: "unhealthy: model not loaded or test embed failed" }),
  });
  if (!healthy || !testOk) {
    process.stderr.write("[exed] Health check failed — exiting for restart.\n");
    void shutdown();
  }
}

function startServer(): void {
  mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

  // Remove stale socket if exists
  try { unlinkSync(SOCKET_PATH); } catch { /* not present */ }

  const server = net.createServer((socket) => {
    _activeConnections++;
    resetIdleTimer();

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const request = JSON.parse(line) as EmbedRequest;

          // Health check — bypasses queue, responds immediately
          if (request.type === "health") {
            void handleHealthCheck(socket, request.id ?? "health");
            continue;
          }

          if (!request.id || !Array.isArray(request.texts)) {
            sendResponse(socket, { id: request.id ?? "unknown", error: "Invalid request: missing id or texts" });
            continue;
          }

          const entry: QueueEntry = { request, socket };

          if (request.priority === "high") {
            highQueue.push(entry);
          } else {
            lowQueue.push(entry);
          }

          void processQueue();
        } catch (err) {
          sendResponse(socket, { id: "parse-error", error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    });

    socket.on("close", () => {
      _activeConnections--;
      checkIdle();
    });

    socket.on("error", () => {
      _activeConnections--;
      checkIdle();
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write("[exed] Socket already in use — another daemon is running. Exiting.\n");
      process.exit(0);
    }
    process.stderr.write(`[exed] Server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    process.stderr.write(`[exed] Listening on ${SOCKET_PATH}\n`);

    // Write PID file
    writeFileSync(PID_PATH, String(process.pid));

    // Start idle timer (will be reset on first connection)
    checkIdle();
  });
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  await loadModel();
  startServer();
} catch (err) {
  process.stderr.write(`[exed] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  process.exit(1);
}
