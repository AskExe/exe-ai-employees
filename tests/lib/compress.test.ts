/**
 * Tests for src/lib/compress.ts — Brotli compression module
 *
 * Covers: AC-COMP-01, AC-COMP-02, AC-COMP-09
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { compress, decompress } from "../../src/lib/compress.js";

// TEST-COMP-01: Basic round-trip
describe("compress.ts — Brotli compression", () => {
  describe("round-trip", () => {
    it("round-trips any UTF-8 buffer", () => {
      const samples = [
        "hello world",
        "emoji: 🚀🔥💻",
        "unicode: 日本語テスト 中文测试",
        "special: <script>alert('xss')</script>",
        "json: " + JSON.stringify({ key: "value", nested: { a: 1, b: [1, 2, 3] } }),
        "long: " + "x".repeat(10000),
        "mixed: abc 日本 🎉 " + "repeat ".repeat(500),
      ];

      for (const text of samples) {
        const buf = Buffer.from(text, "utf8");
        const result = decompress(compress(buf));
        expect(result.toString("utf8")).toBe(text);
      }
    });

    // TEST-COMP-02: Edge cases
    it("handles empty buffer", () => {
      const empty = Buffer.alloc(0);
      const result = decompress(compress(empty));
      expect(result.length).toBe(0);
    });

    it("handles single-byte buffer", () => {
      const single = Buffer.from("x");
      const result = decompress(compress(single));
      expect(result.toString("utf8")).toBe("x");
    });

    it("handles large buffer (100KB+)", () => {
      const large = Buffer.from("a]b[c{d}e\n".repeat(10000));
      const result = decompress(compress(large));
      expect(result.equals(large)).toBe(true);
    });
  });

  // TEST-COMP-03: Return types
  describe("return types", () => {
    it("compress returns a Buffer", () => {
      const result = compress(Buffer.from("test"));
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("decompress returns a Buffer", () => {
      const compressed = compress(Buffer.from("test"));
      const result = decompress(compressed);
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  // TEST-COMP-12: Compression ratio on representative data
  describe("compression ratio (AC-COMP-09)", () => {
    it("achieves >= 2x average ratio on representative text", () => {
      // Representative ~2KB samples matching real tool output sizes
      const samples = [
        // Tool output (typical Bash command result, ~2KB)
        `$ npm test\n> exe-mem@0.2.0 test\n> vitest run\n\n RUN  v3.0.0 /Users/dev/project\n\n` +
        Array.from({ length: 30 }, (_, i) =>
          ` ✓ tests/lib/module-${i}.test.ts (${i + 3} tests) ${10 + i * 5}ms`
        ).join("\n") +
        `\n\n Tests  150 passed\n Time   4.56s\n\nTest Suites: 30 passed, 30 total\nSnapshots:   0 total\nTime:        4.567 s\nRan all test suites.`,

        // Code snippet (typical Read tool output, ~2KB)
        Array.from({ length: 40 }, (_, i) =>
          `export async function handler${i}(req: Request): Promise<Response> {\n` +
          `  const data = await req.json();\n` +
          `  if (!data.id) throw new Error("Missing id");\n` +
          `  return Response.json({ ok: true, id: data.id });\n}\n`
        ).join("\n"),

        // Error message with long stack trace (~2KB)
        `Error: ENOENT: no such file or directory, open '/Users/dev/.exe-mem/config.json'\n` +
        Array.from({ length: 30 }, (_, i) =>
          `    at Object.handler${i} (node:internal/fs:${600 + i}:${3 + i})\n` +
          `    at processQueue (/Users/dev/exe-mem/src/lib/store.ts:${70 + i}:${20 + i})`
        ).join("\n"),

        // JSON data (typical multi-record response, ~2KB)
        JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
          id: `mem_${String(i).padStart(6, "0")}`,
          agent_id: "yoshi",
          agent_role: "CTO",
          session_id: `sess_${crypto.randomUUID().slice(0, 8)}`,
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
          tool_name: ["Bash", "Write", "Read", "Edit"][i % 4],
          project_name: "exe-mem",
          has_error: i % 5 === 0,
          raw_text: `Output line ${i}: some typical tool output content here`,
        }))),
      ];

      let totalOriginal = 0;
      let totalCompressed = 0;

      for (const sample of samples) {
        const original = Buffer.from(sample, "utf8");
        const compressed = compress(original);
        totalOriginal += original.length;
        totalCompressed += compressed.length;

        // Verify round-trip
        expect(decompress(compressed).toString("utf8")).toBe(sample);
      }

      const ratio = totalOriginal / totalCompressed;
      expect(ratio).toBeGreaterThanOrEqual(2.0);
    });
  });
});
