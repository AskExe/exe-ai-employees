import { createWriteStream, createReadStream, existsSync, unlinkSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const GGUF_URL =
  "https://huggingface.co/jinaai/jina-embeddings-v5-text-small-text-matching-GGUF/resolve/main/v5-small-text-matching-Q4_K_M.gguf";
export const EXPECTED_SHA256 = "738555454772b436632c6bad5891aeaa38d414bd7d7185107caeb3b2d8f2d860";
export const EXPECTED_SIZE = 396_836_064;
export const LOCAL_FILENAME = "jina-embeddings-v5-small-q4_k_m.gguf";

export interface DownloadOptions {
  destDir: string;
  onProgress?: (downloaded: number, total: number) => void;
  /** Override fetch for testing */
  fetchFn?: typeof globalThis.fetch;
}

export async function downloadModel(opts: DownloadOptions): Promise<string> {
  const { destDir, onProgress, fetchFn = globalThis.fetch } = opts;
  const destPath = path.join(destDir, LOCAL_FILENAME);
  const tmpPath = destPath + ".tmp";

  await mkdir(destDir, { recursive: true });

  // Skip if already downloaded and verified
  if (existsSync(destPath)) {
    const hash = await fileHash(destPath);
    if (hash === EXPECTED_SHA256) {
      return destPath; // already good
    }
  }

  // Clean up partial downloads
  if (existsSync(tmpPath)) unlinkSync(tmpPath);

  const response = await fetchFn(GGUF_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? EXPECTED_SIZE);
  let downloaded = 0;
  const hash = createHash("sha256");
  const fileStream = createWriteStream(tmpPath);

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!fileStream.write(value)) {
        await new Promise<void>((resolve) => fileStream.once("drain", resolve));
      }
      hash.update(value);
      downloaded += value.byteLength;
      onProgress?.(downloaded, contentLength);
    }
  } finally {
    fileStream.end();
    // Wait for the write stream to finish
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  }

  // Verify SHA256
  const actualHash = hash.digest("hex");
  if (actualHash !== EXPECTED_SHA256) {
    unlinkSync(tmpPath);
    throw new Error(
      `SHA256 mismatch: expected ${EXPECTED_SHA256}, got ${actualHash}`
    );
  }

  renameSync(tmpPath, destPath);
  return destPath;
}

async function fileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
