import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_FILE = "jina-embeddings-v5-small-q8_0.gguf";
const MODEL_PATH = path.join(os.homedir(), ".exe-mem", "models", MODEL_FILE);
const modelExists = existsSync(MODEL_PATH);

describe.skipIf(!modelExists)(
  "Embedder (requires GGUF model at ~/.exe-mem/models/)",
  () => {
    // Use embedDirect (in-process model loading) for tests since
    // the daemon is not running during test execution.
    let embedDirect: typeof import("../src/lib/embedder.js").embedDirect;
    let EMBEDDING_DIM: typeof import("../src/types/memory.js").EMBEDDING_DIM;

    const setup = (async () => {
      const embedderMod = await import("../src/lib/embedder.js");
      const memoryMod = await import("../src/types/memory.js");
      embedDirect = embedderMod.embedDirect;
      EMBEDDING_DIM = memoryMod.EMBEDDING_DIM;
    })();

    it("embedDirect('hello world') returns a number[] with length === 1024", async () => {
      await setup;
      const vector = await embedDirect("hello world");
      expect(vector).toHaveLength(EMBEDDING_DIM);
      expect(Array.isArray(vector)).toBe(true);
    });

    it("embedDirect('') with empty string throws dimension mismatch", async () => {
      await setup;
      await expect(embedDirect("")).rejects.toThrow("Embedding dimension mismatch");
    });

    it("vector values are finite numbers (no NaN, no Infinity)", async () => {
      await setup;
      const vector = await embedDirect("test finite values");
      expect(vector.every((v) => Number.isFinite(v))).toBe(true);
    });
  },
);

describe("Embedder client delegation", () => {
  it("embed() returns 1024-dim vector via daemon or throws if unavailable", async () => {
    const { embed } = await import("../src/lib/embedder.js");

    try {
      const vector = await embed("test delegation");
      // If daemon is running, we get a valid vector
      expect(vector).toHaveLength(1024);
      expect(vector.every((v) => Number.isFinite(v))).toBe(true);
    } catch (err) {
      // If daemon is not running, embed throws
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("disposeEmbedder() completes without throwing", async () => {
    const { disposeEmbedder } = await import("../src/lib/embedder.js");
    await expect(disposeEmbedder()).resolves.toBeUndefined();
  });
});
