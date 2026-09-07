'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

let sqlPromise = null;

function loadSqlJs() {
  if (!sqlPromise) {
    // sql.js is a WASM build, so there is no native module to compile or ship
    // per-architecture — important for a single .deb that works everywhere.
    const initSqlJs = require('sql.js');
    // The .wasm is unpacked from the asar at build time, so point at the real
    // file on disk rather than the archived copy.
    const wasmDir = path
      .dirname(require.resolve('sql.js/dist/sql-wasm.wasm'))
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    sqlPromise = initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  }
  return sqlPromise;
}

/**
 * Read keys out of a VS Code style `state.vscdb` (Cursor, Antigravity, ...).
 *
 * The file is copied to a temp path first: the editor keeps it open and we must
 * never write to (or lock) the original.
 */
async function readItemTable(dbPath, keys) {
  const tmp = path.join(os.tmpdir(), `sup-${process.pid}-${Date.now()}.vscdb`);
  try {
    await fsp.copyFile(dbPath, tmp);
    const SQL = await loadSqlJs();
    const db = new SQL.Database(await fsp.readFile(tmp));
    try {
      const placeholders = keys.map(() => '?').join(',');
      const stmt = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`);
      stmt.bind(keys);
      const out = {};
      while (stmt.step()) {
        const [key, value] = stmt.get();
        out[key] = decodeValue(value);
      }
      stmt.free();
      return out;
    } finally {
      db.close();
    }
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/**
 * Values come back as TEXT or BLOB. Electron has historically written these as
 * BOM-less UTF-16LE, so sniff for that before falling back to UTF-8.
 */
function decodeValue(value) {
  if (typeof value === 'string') return value;
  if (!value) return null;
  const buf = Buffer.from(value);
  if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

module.exports = { readItemTable, decodeValue };
