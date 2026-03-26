/**
 * Embedding daemon client — connects to the embed-daemon via Unix socket.
 *
 * Auto-starts the daemon if it's not running. Falls back to null on failure
 * so callers can degrade to FTS-only search or zero-vector writes.
 *
 * @module embed-client
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, readFileSync, openSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXE_AI_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.EXE_EMBED_SOCK ?? path.join(EXE_AI_DIR, "embed.sock");
const PID_PATH = process.env.EXE_EMBED_PID ?? path.join(EXE_AI_DIR, "embed.pid");
const SPAWN_LOCK_PATH = path.join(EXE_AI_DIR, "embed-spawn.lock");
const SPAWN_LOCK_STALE_MS = 30_000; // Lock older than 30s is considered stale
const CONNECT_TIMEOUT_MS = 15_000; // Max wait for daemon cold start
const REQUEST_TIMEOUT_MS = 30_000; // Max wait for embed response

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _socket: net.Socket | null = null;
let _connected = false;
let _buffer = "";
let _requestCount = 0;
const HEALTH_CHECK_INTERVAL = 100; // verify daemon every N requests
const _pending = new Map<string, {
  resolve: (data: { vectors?: number[][]; error?: string; health?: { status: string; uptime: number; requests_served: number } }) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// ---------------------------------------------------------------------------
// Socket data handler
// ---------------------------------------------------------------------------

function handleData(chunk: Buffer): void {
  _buffer += chunk.toString();

  let newlineIdx: number;
  while ((newlineIdx = _buffer.indexOf("\n")) !== -1) {
    const line = _buffer.slice(0, newlineIdx).trim();
    _buffer = _buffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const response = JSON.parse(line) as { id: string; vectors?: number[][]; error?: string; health?: { status: string; uptime: number; requests_served: number } };
      const entry = _pending.get(response.id);
      if (entry) {
        clearTimeout(entry.timer);
        _pending.delete(response.id);
        entry.resolve(response);
      }
    } catch {
      // Malformed response — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

function cleanupStaleFiles(): void {
  // Check if PID file references a dead process
  if (existsSync(PID_PATH)) {
    try {
      const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
      if (pid > 0) {
        try {
          process.kill(pid, 0); // Signal 0 = check if alive
          return; // Process exists — socket should work
        } catch {
          // Process dead — clean up stale files
        }
      }
    } catch {
      // Can't read PID file
    }
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }
}

function findPackageRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function spawnDaemon(): void {
  const pkgRoot = findPackageRoot();
  if (!pkgRoot) {
    process.stderr.write("[embed-client] WARN: cannot find package root\n");
    return;
  }
  const daemonPath = path.join(pkgRoot, "dist", "lib", "embed-daemon.js");

  if (!existsSync(daemonPath)) {
    process.stderr.write(`[embed-client] WARN: daemon script not found at ${daemonPath}\n`);
    return;
  }

  const resolvedPath = daemonPath;

  process.stderr.write(`[embed-client] Spawning daemon: ${resolvedPath}\n`);

  // Log daemon stderr to a file for debugging
  const logPath = path.join(path.dirname(SOCKET_PATH), "embed-daemon.log");
  let stderrFd: number | "ignore" = "ignore";
  try {
    stderrFd = openSync(logPath, "a");
  } catch {
    // Can't open log — use 'ignore'
  }

  const child = spawn(process.execPath, [resolvedPath], {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: {
      ...process.env,
      EXE_EMBED_SOCK: SOCKET_PATH,
      EXE_EMBED_PID: PID_PATH,
    },
  });

  child.unref();
  if (typeof stderrFd === "number") {
    try { closeSync(stderrFd); } catch { /* ignore */ }
  }
}

/**
 * Acquire an exclusive spawn lock using O_EXCL to prevent thundering herd.
 * Only one process can hold this lock at a time. Stale locks (>30s) are auto-cleaned.
 */
function acquireSpawnLock(): boolean {
  try {
    const fd = openSync(SPAWN_LOCK_PATH, "wx"); // O_WRONLY | O_CREAT | O_EXCL
    closeSync(fd);
    return true;
  } catch {
    // Lock exists — check if stale
    try {
      const stat = statSync(SPAWN_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > SPAWN_LOCK_STALE_MS) {
        try { unlinkSync(SPAWN_LOCK_PATH); } catch { /* race — another process cleaned it */ }
        // Retry once after cleaning stale lock
        try {
          const fd = openSync(SPAWN_LOCK_PATH, "wx");
          closeSync(fd);
          return true;
        } catch { /* another process won the retry race */ }
      }
    } catch { /* can't stat — lock was just cleaned by someone else */ }
    return false;
  }
}

function releaseSpawnLock(): void {
  try { unlinkSync(SPAWN_LOCK_PATH); } catch { /* ignore */ }
}

function connectToSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    if (_socket && _connected) {
      resolve(true);
      return;
    }

    const socket = net.createConnection({ path: SOCKET_PATH });

    const connectTimeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);

    socket.on("connect", () => {
      clearTimeout(connectTimeout);
      _socket = socket;
      _connected = true;
      _buffer = "";

      socket.on("data", handleData);

      socket.on("close", () => {
        _connected = false;
        _socket = null;
        // Reject all pending requests
        for (const [id, entry] of _pending) {
          clearTimeout(entry.timer);
          _pending.delete(id);
          entry.resolve({ error: "Connection closed" });
        }
      });

      socket.on("error", () => {
        _connected = false;
        _socket = null;
      });

      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(connectTimeout);
      resolve(false);
    });
  });
}

/**
 * Connect to the embedding daemon, spawning it if needed.
 * Retries with exponential backoff up to CONNECT_TIMEOUT_MS.
 */
export async function connectEmbedDaemon(): Promise<boolean> {
  // Fast path: already connected
  if (_socket && _connected) return true;

  // Try direct connect first
  if (await connectToSocket()) return true;

  // Daemon not running — acquire spawn lock to prevent thundering herd.
  // Only one process spawns; others skip and wait for the socket.
  if (acquireSpawnLock()) {
    try {
      cleanupStaleFiles();
      spawnDaemon();
    } finally {
      releaseSpawnLock();
    }
  }

  // Retry with exponential backoff (daemon needs 3-8s for model load)
  const start = Date.now();
  let delay = 100;

  while (Date.now() - start < CONNECT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, delay));
    if (await connectToSocket()) return true;
    delay = Math.min(delay * 2, 3000);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Embed API
// ---------------------------------------------------------------------------

function sendRequest(texts: string[], priority: "high" | "low"): Promise<{ vectors?: number[][]; error?: string }> {
  return new Promise((resolve) => {
    if (!_socket || !_connected) {
      resolve({ error: "Not connected" });
      return;
    }

    const id = randomUUID();

    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve({ error: "Request timeout" });
    }, REQUEST_TIMEOUT_MS);

    _pending.set(id, { resolve, timer });

    try {
      _socket.write(JSON.stringify({ id, texts, priority }) + "\n");
    } catch {
      clearTimeout(timer);
      _pending.delete(id);
      resolve({ error: "Write failed" });
    }
  });
}

// ---------------------------------------------------------------------------
// Health check + auto-restart
// ---------------------------------------------------------------------------

/**
 * Send a health check ping to the daemon.
 * Returns health info on success, null on failure.
 */
export async function pingDaemon(): Promise<{ status: string; uptime: number; requests_served: number } | null> {
  if (!_socket || !_connected) return null;

  return new Promise((resolve) => {
    const id = randomUUID();

    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve(null);
    }, 5_000);

    _pending.set(id, {
      resolve: (data) => {
        if (data.health) {
          resolve(data.health);
        } else {
          resolve(null);
        }
      },
      timer,
    });

    try {
      _socket!.write(JSON.stringify({ id, type: "health" }) + "\n");
    } catch {
      clearTimeout(timer);
      _pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Kill the daemon process, clean up stale files, and respawn.
 */
function killAndRespawnDaemon(): void {
  process.stderr.write("[embed-client] Killing daemon for restart...\n");

  // Kill the old process
  if (existsSync(PID_PATH)) {
    try {
      const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    } catch { /* can't read PID */ }
  }

  // Disconnect existing socket
  if (_socket) {
    _socket.destroy();
    _socket = null;
  }
  _connected = false;
  _buffer = "";

  // Clean up stale files
  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }

  // Respawn
  spawnDaemon();
}

/**
 * Embed a single text via the daemon.
 * Includes health checks before requests and auto-restart on failure.
 * @param priority "high" for MCP/hooks (Claude is waiting), "low" for ingest workers
 * @returns 1024-dim vector or null if daemon unavailable
 */
export async function embedViaClient(text: string, priority: "high" | "low" = "high"): Promise<number[] | null> {
  if (!_connected && !(await connectEmbedDaemon())) return null;

  // Periodic health check every HEALTH_CHECK_INTERVAL requests
  _requestCount++;
  if (_requestCount % HEALTH_CHECK_INTERVAL === 0) {
    const health = await pingDaemon();
    if (!health) {
      process.stderr.write(`[embed-client] Periodic health check failed at request ${_requestCount} — restarting daemon\n`);
      killAndRespawnDaemon();
      // Wait for respawn and reconnect
      const start = Date.now();
      let delay = 200;
      while (Date.now() - start < CONNECT_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, delay));
        if (await connectToSocket()) break;
        delay = Math.min(delay * 2, 3000);
      }
      if (!_connected) return null;
    }
  }

  const result = await sendRequest([text], priority);
  if (!result.error && result.vectors?.[0]) return result.vectors[0];

  // First attempt failed — try restart + retry once
  if (result.error) {
    process.stderr.write(`[embed-client] Embed failed (${result.error}) — attempting restart\n`);
    killAndRespawnDaemon();
    const start = Date.now();
    let delay = 200;
    while (Date.now() - start < CONNECT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await connectToSocket()) break;
      delay = Math.min(delay * 2, 3000);
    }
    if (!_connected) return null;

    const retry = await sendRequest([text], priority);
    if (!retry.error && retry.vectors?.[0]) return retry.vectors[0];
    process.stderr.write(`[embed-client] Embed retry also failed: ${retry.error ?? "no vector"}\n`);
  }

  return null;
}

/**
 * Embed multiple texts via the daemon in one request.
 * Includes auto-restart on failure with retry.
 * @returns Array of 1024-dim vectors (same order) or null if daemon unavailable
 */
export async function embedBatchViaClient(texts: string[], priority: "high" | "low" = "high"): Promise<number[][] | null> {
  if (!_connected && !(await connectEmbedDaemon())) return null;

  _requestCount++;
  const result = await sendRequest(texts, priority);
  if (!result.error && result.vectors) return result.vectors;

  // First attempt failed — restart + retry once
  if (result.error) {
    process.stderr.write(`[embed-client] Batch embed failed (${result.error}) — attempting restart\n`);
    killAndRespawnDaemon();
    const start = Date.now();
    let delay = 200;
    while (Date.now() - start < CONNECT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, delay));
      if (await connectToSocket()) break;
      delay = Math.min(delay * 2, 3000);
    }
    if (!_connected) return null;

    const retry = await sendRequest(texts, priority);
    if (!retry.error && retry.vectors) return retry.vectors;
    process.stderr.write(`[embed-client] Batch retry also failed: ${retry.error ?? "no vectors"}\n`);
  }

  return null;
}

/**
 * Disconnect from the daemon. Does NOT shut down the daemon —
 * other processes may still be using it.
 */
export function disconnectClient(): void {
  if (_socket) {
    _socket.destroy();
    _socket = null;
  }
  _connected = false;
  _buffer = "";

  for (const [id, entry] of _pending) {
    clearTimeout(entry.timer);
    _pending.delete(id);
    entry.resolve({ error: "Client disconnected" });
  }
}

/**
 * Check if client is currently connected to the daemon.
 */
export function isClientConnected(): boolean {
  return _connected;
}
