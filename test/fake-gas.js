// Minimal in-memory stand-ins for the Apps Script services used by the API
// (not setup/formatting). Used by `node test/backend.test.js`, and by the
// web app's demo mode, which runs the real Code.js in the browser.
'use strict';
(function (root) {
const nodeCrypto = (typeof require === 'function') ? require('crypto') : null;
const uuid = () => (nodeCrypto ? nodeCrypto.randomUUID() : root.crypto.randomUUID());
// Demo/test only: a 32-byte digest. Node uses real SHA-256; the browser demo
// uses a fast non-cryptographic hash (it never holds real sessions).
function digest(s) {
  if (nodeCrypto) return Array.from(nodeCrypto.createHash('sha256').update(s).digest());
  const out = [];
  for (let k = 0; k < 8; k++) {
    let h = 0x811c9dc5 ^ (k * 0x9e3779b9);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    out.push(h >>> 24 & 255, h >>> 16 & 255, h >>> 8 & 255, h & 255);
  }
  return out;
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) { const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sheet.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { this.sheet.set(this.r, this.c, x); return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getLastRow() { let n = this.data.length; while (n > 0 && this.data[n - 1].every(v => v === '' || v === undefined)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => { let n = r.length; while (n > 0 && (r[n - 1] === '' || r[n - 1] === undefined)) n--; return n; })); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(row) { this.data.push(row.slice()); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
}

function install(g) {
  const sheets = {};
  const props = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
    getUrl: () => 'https://docs.google.com/spreadsheets/d/fake',
    getId: () => 'fake',
  };
  g.SpreadsheetApp = { getActive: () => ss, flush: () => {} };
  g.PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
    deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props),
  }) };
  g.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  g.Utilities = {
    getUuid: uuid,
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, s) => digest(s).map(b => (b > 127 ? b - 256 : b)),
  };
  g.tokeninfo = null; // set by tests
  g.UrlFetchApp = { fetch: () => ({ getResponseCode: () => (g.tokeninfo ? 200 : 400), getContentText: () => JSON.stringify(g.tokeninfo || {}) }) };
  g.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => ({ body: s }) }) };
  g.sentMail = [];
  g.MailApp = { sendEmail: m => g.sentMail.push(m) };
  if (!g.console) g.console = console;
  return { sheets, props, ss, Sheet };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { install };
else root.FakeGAS = { install };
})(typeof globalThis !== 'undefined' ? globalThis : this);
