'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Read the tail of a file and return the parsed JSON objects it contains,
 * oldest first. Session logs grow to tens of megabytes, so we only ever touch
 * the last `bytes` of them.
 */
async function tailJsonl(file, bytes = 256 * 1024) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line is expected whenever we did not start at byte 0.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        /* truncated or interleaved write, skip */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Recursively collect *.jsonl files under `dir`, newest mtime first. */
async function findJsonlFiles(dir, { limit = 40, maxDepth = 6 } = {}) {
  const found = [];

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = await fsp.stat(full);
          found.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }

  await walk(dir, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit);
}

module.exports = { tailJsonl, findJsonlFiles };
