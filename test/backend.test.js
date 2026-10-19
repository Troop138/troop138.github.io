// Run: node test/backend.test.js
// Exercises the Apps Script API logic against in-memory fakes.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { install } = require('./fake-gas');

const ctx = {};
const env = install(ctx);
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.js'), 'utf8') + '\n;this.ACTIONS = ACTIONS;', ctx);

// Build tabs with headers (setup's formatting is not exercised here).
const T = vm.runInContext('TABS', ctx);
Object.values(T).forEach(t => { const s = env.ss.insertSheet(t.name); s.appendRow(t.headers); });
env.ss.getSheetByName('Settings').appendRow(['Google sign-in client ID', 'client-123', '']);
env.ss.getSheetByName('Leaders').appendRow(['admin@example.com', 'Ada', 'Admin', true]);
env.ss.getSheetByName('Leaders').appendRow(['lee@example.com', 'Lee', 'Leader', true]);
env.ss.getSheetByName('Leaders').appendRow(['tess@example.com', 'Tess', 'Treasurer', true]);
const items = env.ss.getSheetByName('Items');
items.appendRow(['i1', 'Tenderfoot', 'Rank', 1.5, 'Free', 3, true]);
items.appendRow(['i2', "Totin' Chip", 'Award & card', 1, 'First one free', 5, true]);
items.appendRow(['i3', 'Merit badge sash', 'Award & card', 7.99, 'Always charge', 2, true]);

// Checkbox columns hold FALSE on empty rows in a real sheet. Reproduce that so
// appends land right under the data, not below the checkboxes.
[['Leaders', 3], ['Items', 6], ['Scouts', 3]].forEach(([tab, col]) => {
  const s = env.ss.getSheetByName(tab);
  for (let r = s.data.length + 1; r <= 40; r++) s.set(r, col + 1, false);
});

function call(action, body) {
  const res = ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ action }, body)) } });
  return JSON.parse(res.body);
}
function login(email) {
  ctx.tokeninfo = { aud: 'client-123', iss: 'https://accounts.google.com', email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) };
  const r = call('login', { idToken: 'x' });
  assert.ok(r.ok, JSON.stringify(r));
  return r.data.token;
}
const api = (token, action, args) => call(action, { token, args });
const ok = r => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

// --- auth
test('rejects requests without a session', () => {
  const r = call('getData', {});
  assert.strictEqual(r.code, 'unauthorized');
});
test('rejects a Google token for another app', () => {
  ctx.tokeninfo = { aud: 'someone-else', iss: 'accounts.google.com', email: 'admin@example.com', email_verified: 'true', exp: String(Date.now() / 1000 + 60) };
  assert.strictEqual(call('login', { idToken: 'x' }).code, 'unauthorized');
});
test('rejects people not on the leader list', () => {
  ctx.tokeninfo = { aud: 'client-123', iss: 'accounts.google.com', email: 'stranger@example.com', email_verified: 'true', exp: String(Date.now() / 1000 + 60) };
  assert.strictEqual(call('login', { idToken: 'x' }).code, 'not_a_leader');
});

test('login works the way the web page sends it (token inside args)', () => {
  ctx.tokeninfo = { aud: 'client-123', iss: 'https://accounts.google.com', email: 'lee@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) };
  const r = call('login', { args: { idToken: 'x' } });
  assert.ok(r.ok, JSON.stringify(r));
});

const admin = login('ADMIN@example.com');
const lee = login('lee@example.com');
const tess = login('tess@example.com');

test('session tokens are stored hashed, not in plain text', () => {
  assert.ok(Object.keys(env.props).every(k => k.indexOf(admin) < 0 && k.indexOf(lee) < 0));
});
test('leaders do not get the leader list or sheet link', () => {
  const d = ok(api(lee, 'getData'));
  assert.strictEqual(d.leaders, undefined); assert.strictEqual(d.sheetUrl, '');
  assert.strictEqual(d.me.role, 'Leader');
  const a = ok(api(admin, 'getData'));
  assert.strictEqual(a.leaders.length, 3);
});

// --- stock + charges
let scoutId;
test('leader adds a scout; it is flagged and admins get an email', () => {
  const r = ok(api(lee, 'addScout', { first: 'Sam', last: 'Rivera' }));
  scoutId = r.id;
  assert.strictEqual(r.needsUpdate, true);
  const s = ok(api(admin, 'getData')).scouts.find(x => x.id === scoutId);
  assert.strictEqual(s.name, 'Sam Rivera'); assert.strictEqual(s.needsUpdate, true); assert.strictEqual(s.addedBy, 'lee@example.com');
  assert.strictEqual(ctx.sentMail.length, 1);
  assert.strictEqual(ctx.sentMail[0].to, 'admin@example.com');
  assert.ok(/Sam Rivera/.test(ctx.sentMail[0].subject));
});
test('first and last name are both required, and duplicates are refused', () => {
  assert.strictEqual(api(lee, 'addScout', { first: 'Sam', last: '' }).code, 'bad_request');
  assert.strictEqual(api(lee, 'addScout', { first: 'sam', last: 'rivera' }).code, 'conflict');
});
test('scouts an admin adds are not flagged and send no email', () => {
  const before = ctx.sentMail.length;
  const r = ok(api(admin, 'addScout', { first: 'Jo', last: 'Lee' }));
  assert.strictEqual(r.needsUpdate, false); assert.strictEqual(ctx.sentMail.length, before);
});
test('only admins edit scouts or mark them updated', () => {
  assert.strictEqual(api(lee, 'updateScout', { id: scoutId, first: 'Samuel', last: 'Rivera' }).code, 'forbidden');
  ok(api(admin, 'updateScout', { id: scoutId, updated: true }));
  assert.strictEqual(ok(api(admin, 'getData')).scouts.find(x => x.id === scoutId).needsUpdate, false);
});
test('restock adds to stock', () => {
  ok(api(lee, 'restock', { lines: [{ itemId: 'i1', qty: 5 }, { itemId: 'i2', qty: 4 }, { itemId: 'i3', qty: 2 }], note: 'Scout Shop' }));
});
let firstGive;
test('first one free: first card free, rank free, sash charged', () => {
  firstGive = ok(api(lee, 'give', { scoutId, lines: [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }, { itemId: 'i3', qty: 1 }] }));
  const d = ok(api(admin, 'getData'));
  const ch = d.charges;
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].itemId, 'i3'); assert.strictEqual(ch[0].amount, 7.99); assert.strictEqual(ch[0].status, 'Pending');
  assert.strictEqual(firstGive.charged, 7.99);
});
test('replacement card is charged', () => {
  const r = ok(api(lee, 'give', { scoutId, lines: [{ itemId: 'i2', qty: 2 }] }));
  assert.strictEqual(r.charged, 2);
});
test('only admins waive; waived charge is recorded as Waived with reason', () => {
  assert.strictEqual(api(lee, 'give', { scoutId, lines: [{ itemId: 'i2', qty: 1, waiveReason: 'Card was misprinted' }] }).code, 'forbidden', 'leaders cannot waive');
  ok(api(admin, 'give', { scoutId, lines: [{ itemId: 'i2', qty: 1, waiveReason: 'Card was misprinted' }] }));
  const ch = ok(api(admin, 'getData')).charges;
  const w = ch.find(c => c.status === 'Waived');
  assert.ok(w); assert.strictEqual(w.reason, 'Card was misprinted');
});
test('on-hand math', () => {
  const d = ok(api(admin, 'getData'));
  const q = id => d.log.filter(l => l.itemId === id).reduce((s, l) => s + l.delta, 0);
  assert.strictEqual(q('i1'), 4); assert.strictEqual(q('i2'), 0); assert.strictEqual(q('i3'), 1);
});
test('shelf count logs the difference', () => {
  ok(api(lee, 'count', { itemId: 'i1', target: 10 }));
  const d = ok(api(admin, 'getData'));
  assert.strictEqual(d.log.filter(l => l.itemId === 'i1').reduce((s, l) => s + l.delta, 0), 10);
});

// --- permissions
test('leaders cannot post charges or edit costs', () => {
  const c = ok(api(admin, 'getData')).charges.find(x => x.status === 'Pending');
  assert.strictEqual(api(lee, 'setChargeStatus', { ids: [c.id], status: 'Transferred to Treasurer' }).code, 'forbidden');
  assert.strictEqual(api(lee, 'updateItem', { id: 'i1', cost: 0 }).code, 'forbidden');
  ok(api(lee, 'updateItem', { id: 'i1', reorder: 4 }));
});
test('treasurer marks charges transferred', () => {
  const pending = ok(api(admin, 'getData')).charges.filter(x => x.status === 'Pending');
  ok(api(tess, 'setChargeStatus', { ids: pending.map(p => p.id), status: 'Transferred to Treasurer' }));
  const after = ok(api(admin, 'getData')).charges;
  assert.ok(after.filter(x => pending.some(p => p.id === x.id)).every(x => x.status === 'Transferred to Treasurer' && x.changedBy === 'tess@example.com'));
});
test('undo is blocked once a charge is transferred', () => {
  assert.strictEqual(api(lee, 'undo', { logIds: firstGive.logIds }).code, 'conflict');
});
test('leaders can undo their own fresh entries, not others', () => {
  const r = ok(api(lee, 'restock', { lines: [{ itemId: 'i1', qty: 1 }] }));
  assert.strictEqual(api(tess, 'undo', { logIds: r.logIds }).code, 'forbidden');
  ok(api(lee, 'undo', { logIds: r.logIds }));
});

// --- check back in
const onHand = id => ok(api(admin, 'getData')).log.filter(l => l.itemId === id).reduce((s, l) => s + l.delta, 0);
test('check back in: back to stock, waives the charge, once', () => {
  ok(api(admin, 'restock', { lines: [{ itemId: 'i3', qty: 3 }] }));
  const g = ok(api(admin, 'give', { scoutId, lines: [{ itemId: 'i3', qty: 1 }] }));
  const logId = g.logIds[0], before = onHand('i3');
  assert.strictEqual(ok(api(admin, 'getData')).charges.find(c => c.logId === logId).status, 'Pending');
  const r = ok(api(lee, 'checkIn', { logIds: [logId] }));
  assert.strictEqual(r.returned, 1);
  assert.strictEqual(ok(api(lee, 'checkIn', { logIds: [logId] })).returned, 0, 'checked in twice');
  assert.strictEqual(onHand('i3'), before + 1);
  let d = ok(api(lee, 'getData'));
  const c = d.charges.find(x => x.logId === logId); assert.strictEqual(c.status, 'Waived'); assert.strictEqual(c.reason, 'Checked back in');
  const ret = d.log.find(l => l.kind === 'return'); assert.strictEqual(ret.scoutId, scoutId); assert.strictEqual(ret.returns, logId);
  // undo the check-in: charge back to pending
  ok(api(lee, 'undo', { logIds: r.logIds }));
  d = ok(api(lee, 'getData'));
  assert.strictEqual(d.charges.find(x => x.logId === logId).status, 'Pending');
  assert.strictEqual(onHand('i3'), before);
});
test('first-one-free: a checked-in item does not use up the free one', () => {
  const s2 = ok(api(admin, 'addScout', { first: 'Free', last: 'Test' })).id;
  const g = ok(api(admin, 'give', { scoutId: s2, lines: [{ itemId: 'i2', qty: 1 }] }));
  assert.strictEqual(g.charged, 0);
  ok(api(admin, 'checkIn', { logIds: g.logIds }));
  assert.strictEqual(ok(api(admin, 'give', { scoutId: s2, lines: [{ itemId: 'i2', qty: 1 }] })).charged, 0);
});

// --- leaders
test('removing a leader signs them out', () => {
  ok(api(admin, 'saveLeader', { email: 'lee@example.com', name: 'Lee', role: 'Leader', active: false }));
  assert.strictEqual(api(lee, 'getData').code, 'unauthorized');
});
test('the only admin cannot demote themselves', () => {
  assert.strictEqual(api(admin, 'saveLeader', { email: 'admin@example.com', role: 'Leader' }).code, 'conflict');
});
test('signOutEverywhere revokes all sessions for that person', () => {
  const t2 = login('tess@example.com');
  ok(api(admin, 'signOutEverywhere', { email: 'tess@example.com' }));
  assert.strictEqual(api(tess, 'getData').code, 'unauthorized');
  assert.strictEqual(api(t2, 'getData').code, 'unauthorized');
});

console.log(`\n${passed} passed`);
