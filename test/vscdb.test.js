'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readItemTable, decodeValue } = require('../src/main/lib/vscdb');

/** Build a throwaway state.vscdb shaped like the ones Cursor writes. */
async function makeDb(rows) {
  const initSqlJs = require('sql.js');
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  const db = new SQL.Database();
  db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const stmt = db.prepare('INSERT INTO ItemTable VALUES (?, ?)');
  for (const [key, value] of rows) stmt.run([key, value]);
  stmt.free();
  const bytes = Buffer.from(db.export());
  db.close();

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-')), 'state.vscdb');
  fs.writeFileSync(file, bytes);
  return file;
}

test('vscdb: reads the requested keys and ignores the rest', async () => {
  const file = await makeDb([
    ['cursorAuth/accessToken', 'header.payload.sig'],
    ['cursorAuth/cachedEmail', 'me@example.com'],
    ['something/else', 'ignored'],
  ]);

  const items = await readItemTable(file, ['cursorAuth/accessToken', 'cursorAuth/cachedEmail']);
  assert.equal(items['cursorAuth/accessToken'], 'header.payload.sig');
  assert.equal(items['cursorAuth/cachedEmail'], 'me@example.com');
  assert.equal(items['something/else'], undefined);
});

test('vscdb: the original file is left untouched', async () => {
  const file = await makeDb([['cursorAuth/accessToken', 'abc']]);
  const before = fs.readFileSync(file);
  await readItemTable(file, ['cursorAuth/accessToken']);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('vscdb: decodes BOM-less UTF-16LE blobs as well as UTF-8', () => {
  assert.equal(decodeValue(Buffer.from('token', 'utf16le')), 'token');
  assert.equal(decodeValue(Buffer.from('token', 'utf8')), 'token');
  assert.equal(decodeValue(null), null);
});
