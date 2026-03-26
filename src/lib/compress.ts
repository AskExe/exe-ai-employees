/**
 * Brotli compression for memory records.
 *
 * Uses Node.js built-in zlib Brotli — zero external dependencies.
 * Brotli achieves excellent compression on text (tool outputs, code, errors)
 * with ratios comparable to Zstandard (3-5x on typical content).
 *
 * @module compress
 */

import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

/**
 * Compress a Buffer using Brotli (quality 4 — fast, good ratio for text).
 */
export function compress(input: Buffer): Buffer {
  if (input.length === 0) return Buffer.alloc(0);
  return brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
    },
  });
}

/**
 * Decompress a Brotli-compressed Buffer.
 */
export function decompress(input: Buffer): Buffer {
  if (input.length === 0) return Buffer.alloc(0);
  return brotliDecompressSync(input);
}
