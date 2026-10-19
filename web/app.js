/* Troop Closet web app. Plain JavaScript, no build step.
 * Talks to the Apps Script data API configured in config.js. */
(function () {
'use strict';

const CFG = window.CLOSET_CONFIG || {};
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') || CFG.apiUrl === 'demo';

const CATS = ['Rank', 'Patrol patch', 'Merit badge', 'Uniform', 'Position', 'Pin', 'Award & card', 'Eagle', 'Other'];
const CAT_SHORT = { 'Rank': 'Ranks', 'Patrol patch': 'Patrol patches', 'Merit badge': 'Merit badges', 'Uniform': 'Uniform', 'Position': 'Position', 'Pin': 'Pins', 'Eagle': 'Eagle', 'Award & card': 'Awards & cards', 'Other': 'Other' };
// Eagle-required merit badges get a small eagle next to their name.
const nameEl = (it, cls) => el('div', { class: 'name' + (cls ? ' ' + cls : '') }, it.name, it.eagleReq ? el('span', { class: 'eaglereq', title: 'Eagle required', 'aria-label': 'Eagle required', text: '🦅' }) : null);
const RULES = ['Free', 'Always charge', 'First one free'];
const ROLES = ['Admin', 'Leader', 'Treasurer'];

const S = {
  token: '', me: null, settings: { appTitle: 'Troop Closet', troopName: '' }, sheetUrl: '',
  items: new Map(), scouts: new Map(), log: [], charges: [], leaders: [], qty: new Map(),
  ready: false, error: '', busy: false,
  tab: 'give', sub: '', q: '', cat: 'all',
  give: { scoutId: null, cart: {} }, restock: { cart: {}, note: '' },
  scoutQ: '', pendingDel: null,
  returned: new Set(), ret: { sel: {}, day: '' },
  report: '', rep: { range: '30', from: '', to: '', group: 'item', scout: '', status: 'Pending', sel: {} },
};

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v; // only ever given trusted constants
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(String(k))); }
  return e;
}
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n || 0).toFixed(2);
const fmtDate = t => { const d = new Date(t); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
const fmtShort = t => new Date(t).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const who = e => (e || '').split('@')[0];
const isRole = (...r) => S.me && r.includes(S.me.role);
const activeItems = () => [...S.items.values()].filter(i => i.active);
const activeScouts = () => [...S.scouts.values()].filter(s => s.active).sort(byName);
const qtyOf = id => S.qty.get(id) || 0;
// Reorder at 0 = not kept in stock (bought when a scout needs one): never Low/Out.
function status(it) { const q = qtyOf(it.id); if (!(it.reorder > 0)) return 'ok'; if (q <= 0) return 'out'; if (q <= it.reorder) return 'low'; return 'ok'; }
function leaderName(email) { const l = S.leaders.find(x => x.email === email); return (l && l.name) || who(email); }

const ICONS = {
  stock: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  give: '<circle cx="12" cy="9" r="5"/><path d="M8.5 13l-2 8 5.5-3 5.5 3-2-8"/>',
  restock: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M12 10v7M8.5 13.5h7"/><path d="M7 7V5a2 2 0 012-2h6a2 2 0 012 2v2"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  scouts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.6c2.6.2 4.4 1.9 5 4.9"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const icon = name => el('span', { 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`, style: 'display:inline-flex' });

let toastTimer;
function toast(msg, undo) {
  const r = $('#toastroot'); r.replaceChildren(); clearTimeout(toastTimer);
  r.append(el('div', { class: 'toast', role: 'status' }, el('span', { text: msg }),
    undo ? el('button', { type: 'button', text: 'Undo', onclick: async () => { r.replaceChildren(); await undo(); } }) : null));
  toastTimer = setTimeout(() => r.replaceChildren(), undo ? 7000 : 3500);
}
function fail(e) { console.error(e); toast((e && e.message) || "Couldn't save. Check your connection and try again."); }

/* ---------- API ---------- */
let freshData = null; // the updated closet the server sends back with each change
async function api(action, args) {
  let res;
  if (DEMO) {
    res = window.ClosetDemo.call({ action, token: S.token, args });
  } else {
    let r;
    try {
      r = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, token: S.token, args }), redirect: 'follow' });
    } catch (e) { throw Object.assign(new Error("Can't reach the closet right now. Check your connection."), { code: 'network' }); }
    try { res = await r.json(); } catch (e) { throw Object.assign(new Error('The closet sent back something unexpected. Try again.'), { code: 'server_error' }); }
  }
  if (!res.ok) {
    const err = Object.assign(new Error(res.error || 'Something went wrong.'), { code: res.code });
    if (res.code === 'unauthorized' && action !== 'login') { signOutLocal(); showSignIn(res.error); }
    throw err;
  }
  freshData = res.fresh || null;
  return res.data;
}

function applyData(d) {
    S.me = d.me; S.settings = d.settings; S.sheetUrl = d.sheetUrl || '';
    S.items = new Map(d.items.map(i => [i.id, i]));
    S.scouts = new Map(d.scouts.map(s => [s.id, s]));
    S.log = d.log; S.charges = d.charges; S.leaders = d.leaders || [];
    S.returned = new Set(S.log.filter(l => l.kind === 'return' && l.returns).map(l => l.returns));
    recount();
    S.error = ''; S.ready = true;
}
async function refresh() {
  try { applyData(await api('getData')); }
  catch (e) { if (e.code !== 'unauthorized') S.error = e.message; else return; }
  S.ready = true; soon();
}
function recount() { const m = new Map(); for (const l of S.log) m.set(l.itemId, (m.get(l.itemId) || 0) + l.delta); S.qty = m; }
/** Remove log entries: update the screen right away, then save; on failure reload and say so. */
async function removeEntries(ids, msg) {
  const set = new Set(ids), before = S.log, beforeCh = S.charges;
  S.log = S.log.filter(l => !set.has(l.id)); S.charges = S.charges.filter(c => !set.has(c.logId)); recount();
  S.pending = (S.pending || 0) + 1; render(); toast('Removing…');
  try { await send('undo', { logIds: ids }); toast(msg); }
  catch (e) { S.log = before; S.charges = beforeCh; recount(); fail(e); }
  finally { S.pending--; soon(); }
}
/** Send a change; the reply carries the updated closet, so one round trip is enough. */
async function send(action, args) {
  const r = await api(action, args);
  if (freshData) { applyData(freshData); freshData = null; } else await refresh();
  return r;
}
async function write(action, args, msg) {
  S.busy = true; render();
  try { const r = await send(action, args); if (msg) toast(msg); return r; }
  finally { S.busy = false; soon(); }
}

/* ---------- sign-in ---------- */
function signOutLocal() { S.token = ''; S.me = null; S.ready = false; lsSet('tc.token', ''); }

function showSignIn(message) {
  closeSheet();
  const app = $('#app'); app.replaceChildren();
  const err = el('div', { class: 'err', text: message || '' });
  const card = el('div', { class: 'card' },
    el('img', { class: 'mark', src: 'icons/icon-192.png', alt: '' }),
    el('h1', { text: 'Troop Closet' }),
    el('p', { class: 'muted', style: 'margin:0', text: 'Advancement inventory for troop leaders.' }));
  if (DEMO) {
    card.append(el('p', { class: 'mini muted', style: 'margin:0', text: 'Demo with sample data. Nothing is saved. Pick a role to try:' }),
      ...['Admin', 'Leader', 'Treasurer'].map(role => el('button', { class: 'btn' + (role === 'Admin' ? ' primary' : ''), type: 'button', style: 'width:100%', onclick: () => {
        S.token = window.ClosetDemo.login(`demo.${role.toLowerCase()}@example.com`); startApp();
      } }, `Sign in as demo ${role}`)));
  } else if (!CFG.apiUrl || !CFG.googleClientId) {
    card.append(el('p', { class: 'mini', text: 'This copy of the app is not connected yet. Fill in config.js (see the README).' }),
      el('a', { class: 'btn', href: '?demo=1' }, 'Try the demo'));
  } else {
    const holder = el('div', { id: 'gsi' });
    card.append(holder, el('p', { class: 'mini muted', style: 'margin:0', text: 'Use the Google account the closet admin added for you.' }));
    loadGoogle().then(() => {
      window.google.accounts.id.initialize({
        client_id: CFG.googleClientId, ux_mode: 'popup', auto_select: true, itp_support: true,
        callback: async (r) => {
          err.textContent = 'Signing in…';
          try { const d = await api('login', { idToken: r.credential }); S.token = d.token; lsSet('tc.token', d.token); startApp(); }
          catch (e) { err.textContent = e.message; }
        },
      });
      window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
    }).catch(() => { err.textContent = "Couldn't load Google sign-in. Check your connection and reload."; });
  }
  card.append(err);
  app.append(el('div', { class: 'signin' }, card));
}
let gPromise;
function loadGoogle() {
  if (window.google && window.google.accounts) return Promise.resolve();
  return gPromise || (gPromise = loadScript('https://accounts.google.com/gsi/client'));
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.append(s); }); }

async function signOut() {
  try { await api('logout'); } catch (e) { /* already gone */ }
  try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
  signOutLocal(); showSignIn('Signed out.');
}

/* ---------- app shell ---------- */
const TABS = [['give', 'Give out'], ['scouts', 'Scouts'], ['stock', 'Inventory'], ['restock', 'Restock'], ['reports', 'Reports'], ['more', 'More']];

function startApp() {
  S.tab = 'give'; // always open on Give out
  const app = $('#app'); app.replaceChildren();
  app.append(
    el('div', { class: 'wrap' },
      el('header', { class: 'top' },
        el('div', { class: 'brand' }, el('h1', { id: 'apptitle' }, 'Troop Closet', el('small', { id: 'sub' })), el('div', { class: 'viewtitle', id: 'viewtitle' })),
        el('div', { class: 'toolbar', id: 'toolbar' })),
      el('div', { id: 'banner' }),
      el('div', { class: 'layout', id: 'layout' }, el('main', { id: 'view' }), el('aside', { class: 'side', id: 'aside' }))),
    el('div', { class: 'actionbar', id: 'actionbar', hidden: true }, el('div', { class: 'inner' }, el('div', { class: 'sum', id: 'actionsum' }), el('button', { class: 'btn primary', id: 'actionbtn', type: 'button' }))),
    el('nav', { class: 'tabs', 'aria-label': 'Sections' }, el('div', { class: 'in' }, el('div', { class: 'railhead', id: 'railhead', text: 'Troop Closet' }),
      TABS.map(([k, label]) => el('button', { type: 'button', 'data-tab': k, onclick: () => go(k) }, icon(k === 'give' ? 'give' : k), el('span', { text: label }), el('span', { class: 'badge', hidden: true }))))));
  render(true);
  refresh();
}
function go(tab, sub) {
  S.tab = tab; S.sub = sub || ''; S.q = ''; S.cat = 'all'; if (tab !== 'reports') S.report = '';
  closeSheet(); render(true); window.scrollTo(0, 0);
}

let raf = 0;
function soon() {
  if (raf || !S.token) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const a = document.activeElement;
    const keep = a && a.id && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') ? a.id : null;
    const pos = keep && a.selectionStart;
    render();
    if (sheetFor && !(keep && document.querySelector('.sheet #' + CSS.escape(keep)))) drawSheet();
    if (keep) { const n = document.getElementById(keep); if (n && n !== document.activeElement) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* not text */ } } }
  });
}

function render(full) {
  if (!$('#view')) return;
  const pending = S.charges.filter(c => c.status === 'Pending').length;
  const rosterTodo = [...S.scouts.values()].filter(s => s.needsUpdate).length;
  document.querySelectorAll('nav.tabs button').forEach(b => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    const badge = b.querySelector('.badge');
    if (b.dataset.tab === 'reports') { badge.hidden = !(isRole('Admin', 'Treasurer') && pending); badge.textContent = pending; }
    if (b.dataset.tab === 'scouts') { badge.hidden = !(isRole('Admin') && rosterTodo); badge.textContent = rosterTodo; }
  });
  const title = S.settings.appTitle || 'Troop Closet';
  $('#apptitle').firstChild.textContent = title; $('#railhead').textContent = title; document.title = title;
  $('#sub').textContent = [S.settings.troopName, S.me ? `${S.me.name} · ${S.me.role}` : ''].filter(Boolean).join(' · ');
  $('#viewtitle').textContent = Object.fromEntries(TABS)[S.tab];
  const banner = $('#banner'); banner.replaceChildren();
  if (DEMO) banner.append(el('div', { class: 'banner demo', text: 'Demo mode: sample data only. Changes disappear when you reload.' }));
  if (S.error) banner.append(el('div', { class: 'banner', text: "Couldn't load the closet: " + S.error }));
  if (isRole('Admin') && rosterTodo && S.tab !== 'scouts') banner.append(el('div', { class: 'banner', style: 'display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap' },
    el('span', { text: `${rosterTodo} new scout${rosterTodo > 1 ? 's need' : ' needs'} roster details updated.` }),
    el('button', { class: 'btn small', type: 'button', onclick: () => go('scouts') }, 'Review')));
  if (full) renderToolbar();
  $('#layout').className = 'layout'; document.body.classList.remove('split'); $('#aside').replaceChildren();
  ({ stock: viewStock, give: viewGive, scouts: viewScoutsTab, restock: viewRestock, reports: viewReports, more: viewMore })[S.tab]();
}

function setSplit() { $('#layout').className = 'layout split'; document.body.classList.add('split'); }

function searchBox(ph, val, on, id) {
  const i = el('input', { class: 'search', id, type: 'search', placeholder: ph, value: val, autocomplete: 'off', enterkeyhint: 'search' });
  i.addEventListener('input', () => on(i.value)); return i;
}
function catChips(extra) {
  const opts = [['all', 'All'], ...(extra || []), ...CATS.filter(c => activeItems().some(i => i.cat === c)).map(c => [c, CAT_SHORT[c]])];
  return el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' }, opts.map(([k, l]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.cat === k), text: l, onclick: () => { S.cat = k; renderToolbar(); render(); } })));
}
function renderToolbar() {
  const tb = $('#toolbar'); if (!tb) return; tb.replaceChildren();
  const itemSearch = (id) => el('div', { class: 'searchrow' }, searchBox('Search items', S.q, v => { S.q = v; render(); }, id));
  if (S.tab === 'stock') tb.append(itemSearch('q-stock'), catChips([['low', 'Low / out']]));
  else if (S.tab === 'give' && S.give.scoutId) tb.append(itemSearch('q-give'), catChips());
  else if (S.tab === 'give') tb.append(searchBox('Who is getting items?', S.scoutQ, v => { S.scoutQ = v; render(); }, 'q-scout'));
  else if (S.tab === 'restock') tb.append(itemSearch('q-restock'), catChips());
  else if (S.tab === 'scouts') tb.append(searchBox('Find a scout', S.scoutListQ || '', v => { S.scoutListQ = v; render(); }, 'q-scouts'));
}
function filteredItems() {
  const q = S.q.trim().toLowerCase();
  return activeItems().filter(i => (!q || i.name.toLowerCase().includes(q)) &&
    (S.cat === 'all' || (S.cat === 'low' ? status(i) !== 'ok' : i.cat === S.cat)));
}
function grouped(items) {
  const out = [];
  for (const c of CATS) { const g = items.filter(i => i.cat === c).sort(byName); if (g.length) out.push([c, g]); }
  return out;
}
function itemSub(it) {
  const s = status(it);
  return el('div', { class: 'sub' },
    s === 'out' ? el('span', { class: 'pill out', text: 'Out' }) : s === 'low' ? el('span', { class: 'pill low', text: 'Low' }) : null,
    it.cost > 0 ? el('span', { text: money(it.cost) + (it.rule === 'Free' ? '' : it.rule === 'Always charge' ? ' · charged' : ' · first free') }) : null);
}
function setAction(label, sum, on, disabled) {
  const bar = $('#actionbar'), b = $('#actionbtn');
  if (!label) { bar.hidden = true; return; }
  bar.hidden = false; b.textContent = label; b.disabled = !!disabled; b.onclick = on; $('#actionsum').textContent = sum || '';
}
function loading() { if (!S.ready) { $('#view').replaceChildren(el('div', { class: 'empty', text: 'Loading the closet…' })); return true; } return false; }

/* ---------- Stock ---------- */
function viewStock() {
  setAction(null); if (loading()) return;
  const v = $('#view'); v.replaceChildren();
  const all = activeItems();
  if (!all.length) {
    v.append(el('div', { class: 'empty' }, el('strong', { text: 'The closet is empty' }),
      el('span', { text: isRole('Admin') ? 'Add the badges and cards you keep on the shelf.' : 'Ask the closet admin to add items.' }),
      isRole('Admin') ? el('button', { class: 'btn primary', type: 'button', onclick: () => itemForm() }, 'Add an item') : null));
    return;
  }
  const low = all.filter(i => status(i) === 'low').length, out = all.filter(i => status(i) === 'out').length;
  const units = all.reduce((a, i) => a + Math.max(0, qtyOf(i.id)), 0);
  v.append(el('p', { class: 'muted mini', style: 'margin:12px 2px 0' }, `${all.length} items · ${units} on the shelf · `,
    el('span', { style: 'color:var(--warn-fg);font-weight:600', text: `${low} low` }), ', ',
    el('span', { style: 'color:var(--bad-fg);font-weight:600', text: `${out} out` })));
  const items = filteredItems(), list = el('div', { class: 'list' });
  if (!items.length) list.append(el('div', { class: 'empty', text: 'No items match.' }));
  for (const [c, g] of grouped(items)) {
    list.append(el('div', { class: 'group-h', text: CAT_SHORT[c] }));
    for (const it of g) list.append(el('button', { type: 'button', class: 'row tap', onclick: () => itemSheet(it.id) },
      el('div', { class: 'main' }, nameEl(it), itemSub(it)), el('div', { class: 'qty', text: String(qtyOf(it.id)) })));
  }
  v.append(list);
  if (isRole('Admin')) v.append(el('div', { style: 'display:flex;justify-content:center;padding-top:20px' }, el('button', { class: 'btn', type: 'button', onclick: () => itemForm() }, '+ Add item')));
}

/* ---------- carts (Give / Restock) ---------- */
// Items checked back in don't count toward a scout's free one.
const isGive = l => l.kind === 'out' || l.kind === 'return';
function priorOut(scoutId, itemId) { return S.log.filter(l => isGive(l) && l.scoutId === scoutId && l.itemId === itemId).reduce((s, l) => s - l.delta, 0); }
function chargedQty(it, scoutId, n) {
  if (!n || !(it.cost > 0)) return 0;
  if (it.rule === 'Always charge') return n;
  if (it.rule === 'First one free') return priorOut(scoutId, it.id) > 0 ? n : n - 1;
  return 0;
}
function addToCart(cart, id, k) {
  const cur = cart[id] || { n: 0, waive: null };
  cur.n = Math.max(0, cur.n + k);
  if (cur.n) cart[id] = cur; else delete cart[id];
}
const cartCount = c => Object.values(c).reduce((a, b) => a + b.n, 0);
function cartCharges(cart, scoutId) {
  let due = 0, waived = 0, missingReason = false;
  for (const [id, line] of Object.entries(cart)) {
    const it = S.items.get(id); if (!it) continue;
    const amt = chargedQty(it, scoutId, line.n) * it.cost;
    if (line.waive !== null) { waived += amt; if (amt && !line.waive.trim()) missingReason = true; } else due += amt;
  }
  return { due, waived, missingReason };
}

function cartRows(cart, mode) {
  const items = filteredItems(), list = el('div', { class: 'list' });
  if (!activeItems().length) { list.append(el('div', { class: 'empty', text: 'No items yet.' })); return list; }
  if (!items.length) list.append(el('div', { class: 'empty', text: 'No items match.' }));
  for (const [c, g] of grouped(items)) {
    list.append(el('div', { class: 'group-h', text: CAT_SHORT[c] }));
    for (const it of g) {
      const line = cart[it.id], n = line ? line.n : 0, have = qtyOf(it.id), short = mode === 'give' && n > have;
      const set = k => { addToCart(cart, it.id, k); render(); };
      const main = el('div', { class: 'main' }, nameEl(it),
        el('div', { class: 'onhand' + (short ? ' short' : ''), text: short ? `Only ${have} on hand` : `${have} on hand` + (mode === 'restock' && n ? ` → ${have + n}` : '') }));
      if (mode === 'restock' && n) {
        // Price paid this time; defaults to the item's current cost (the last price paid).
        if (line.price == null) line.price = (it.cost || 0).toFixed(2);
        const inp = el('input', { id: 'price-' + it.id, type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: line.price, style: 'max-width:110px;min-height:38px;padding:6px 10px', 'aria-label': `Price paid each for ${it.name}` });
        inp.addEventListener('input', () => { line.price = inp.value; renderCartSummary(); });
        const changed = Math.abs((Number(line.price) || 0) - (it.cost || 0)) > 0.004;
        main.append(el('div', { class: 'sub', style: 'align-items:center;gap:8px;margin-top:4px' }, el('label', { for: 'price-' + it.id, class: 'mini muted', text: 'Paid each $' }), inp,
          changed ? el('span', { class: 'pill', text: `was ${money(it.cost)}` }) : null));
      }
      if (mode === 'give' && n) {
        const cq = chargedQty(it, S.give.scoutId, n);
        if (cq > 0) {
          const amt = money(cq * it.cost), replacing = it.rule === 'First one free';
          const sub = el('div', { class: 'sub' });
          if (line.waive === null) {
            sub.append(...[el('span', { class: 'pill charge', text: `${replacing ? 'Replacement' : 'Charge'} · ${amt}` }),
              !isRole('Admin') ? null : el('button', { class: 'linkbtn', type: 'button', onclick: () => { line.waive = ''; render(); setTimeout(() => { const x = document.getElementById('waive-' + it.id); if (x) x.focus(); }, 30); } }, 'No charge')].filter(Boolean));
            main.append(sub);
          } else {
            const inp = el('input', { id: 'waive-' + it.id, placeholder: 'Why no charge? (required)', value: line.waive, autocomplete: 'off' });
            inp.addEventListener('input', () => { line.waive = inp.value; renderCartSummary(); });
            main.append(el('div', { class: 'waive' }, el('span', { class: 'pill', text: `Not charging ${amt}` }), inp,
              el('button', { class: 'linkbtn', type: 'button', onclick: () => { line.waive = null; render(); } }, 'Charge it')));
          }
        }
      }
      list.append(el('div', { class: 'row' }, main,
        el('div', { class: 'stepper' },
          el('button', { type: 'button', 'aria-label': 'Remove one ' + it.name, disabled: !n, onclick: () => set(-1) }, '−'),
          el('span', { class: 'n' + (n ? '' : ' zero'), text: String(n) }),
          el('button', { type: 'button', class: 'plus', 'aria-label': 'Add one ' + it.name, onclick: () => set(1) }, '+'))));
    }
  }
  return list;
}

let summaryHook = null;
function renderCartSummary() { if (summaryHook) summaryHook(); }

/* ---------- Give out ---------- */
function viewGive() {
  if (loading()) { setAction(null); return; }
  const v = $('#view'); v.replaceChildren(); const g = S.give;
  if (g.scoutId && !S.scouts.has(g.scoutId)) { g.scoutId = null; renderToolbar(); }
  if (!g.scoutId) {
    setAction(null); summaryHook = null;
    v.append(el('p', { class: 'muted mini', style: 'margin:12px 2px 0', text: 'Step 1 of 2 · Pick the scout receiving items' }));
    const q = S.scoutQ.trim().toLowerCase();
    const sc = activeScouts().filter(s => !q || s.name.toLowerCase().includes(q));
    const list = el('div', { class: 'list' });
    for (const s of sc) list.append(el('button', { type: 'button', class: 'row tap', onclick: () => pickScout(s.id) },
      el('div', { class: 'main' }, el('div', { class: 'name', text: s.name })), el('span', { class: 'muted', 'aria-hidden': 'true', text: '›' })));
    if (!activeScouts().length) list.append(el('div', { class: 'empty' }, el('strong', { text: 'No scouts yet' }), el('span', { text: 'Add the first scout below.' })));
    else if (!sc.length) list.append(el('div', { class: 'empty', text: 'No scout by that name. New to the troop? Add them below.' }));
    v.append(list, addScoutButton(S.scoutQ, id => pickScout(id)));
    return;
  }
  const s = S.scouts.get(g.scoutId);
  setSplit();
  v.append(el('div', { class: 'who' }, el('span', {}, el('span', { class: 'label', text: 'Step 2 of 2 · Giving to' }), s.name),
    el('button', { class: 'btn small', type: 'button', onclick: () => { g.scoutId = null; g.cart = {}; S.scoutQ = ''; renderToolbar(); render(); } }, 'Change')));
  v.append(cartRows(g.cart, 'give'));
  const confirm = async () => {
    const c = cartCharges(g.cart, g.scoutId);
    if (c.missingReason) { toast('Add a reason for each item you are not charging.'); return; }
    const n = cartCount(g.cart);
    const lines = Object.entries(g.cart).map(([itemId, l]) => ({ itemId, qty: l.n, waiveReason: l.waive !== null ? (l.waive.trim() || 'No reason given') : '' }));
    // Clear the screen right away and save in the background; put the cart back if the save fails.
    const cart = g.cart, scoutId = g.scoutId;
    lines.forEach(l => S.qty.set(l.itemId, qtyOf(l.itemId) - l.qty));
    g.cart = {}; g.scoutId = null; S.scoutQ = ''; S.q = ''; S.pending = (S.pending || 0) + 1; renderToolbar(); render(); window.scrollTo(0, 0);
    toast(`Saving ${n} item${n > 1 ? 's' : ''} for ${s.name}…`);
    try {
      const r = await send('give', { scoutId, lines });
      const undo = async () => { try { await write('undo', { logIds: r.logIds }, 'Undone'); } catch (e) { fail(e); } };
      toast(`Logged ${n} item${n > 1 ? 's' : ''} to ${s.name}` + (r.charged ? ` · ${money(r.charged)} charge` : ''), undo);
    } catch (e) {
      lines.forEach(l => S.qty.set(l.itemId, qtyOf(l.itemId) + l.qty));
      if (!g.scoutId && !cartCount(g.cart)) { g.scoutId = scoutId; g.cart = cart; renderToolbar(); }
      toast(`Not saved: ${(e && e.message) || "couldn't reach the closet"} Your items are still in the cart.`);
    } finally { S.pending--; soon(); }
  };
  summaryHook = () => {
    const n = cartCount(g.cart), c = cartCharges(g.cart, g.scoutId);
    const label = S.busy ? 'Saving…' : n ? `Give ${n} item${n > 1 ? 's' : ''} to ${s.name}` : "Tap + on what they're receiving";
    const sum = n ? [c.due ? `${money(c.due)} will be charged` : 'No charge', c.waived ? `${money(c.waived)} not charged` : ''].filter(Boolean).join(' · ') : '';
    setAction(label, sum, confirm, !n || S.busy);
    const a = $('#aside'); a.replaceChildren(
      el('h3', { text: `Giving to ${s.name}` }),
      n ? el('div', {}, Object.entries(g.cart).map(([id, l]) => { const it = S.items.get(id); return el('div', { class: 'cartline' }, el('span', { text: it ? it.name : id }), el('span', { text: '×' + l.n })); }))
        : el('p', { class: 'muted mini', text: 'Tap + on items.' }),
      n ? el('div', { class: 'mini muted', text: sum }) : null,
      el('button', { class: 'btn primary', type: 'button', disabled: !n || S.busy, onclick: confirm }, label));
  };
  summaryHook();
}
function pickScout(id) { S.give.scoutId = id; S.give.cart = {}; S.q = ''; S.cat = 'all'; renderToolbar(); render(); window.scrollTo(0, 0); }

function addScoutButton(prefill, then) {
  return el('div', { style: 'display:flex;justify-content:center;padding-top:16px' },
    el('button', { class: 'btn', type: 'button', onclick: () => scoutForm(prefill, then) }, '+ Add a scout'));
}
function scoutForm(prefill, then) {
  const parts = String(prefill || '').trim().split(/\s+/).filter(Boolean);
  openSheet(() => {
    const first = el('input', { id: 'ffirst', value: parts[0] || '', autocomplete: 'off', autocapitalize: 'words' });
    const last = el('input', { id: 'flast', value: parts.slice(1).join(' '), autocomplete: 'off', autocapitalize: 'words' });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Add scout');
    return el('form', { style: 'display:contents', onsubmit: async e => {
      e.preventDefault();
      if (!first.value.trim()) return first.focus();
      if (!last.value.trim()) return last.focus();
      btn.disabled = true;
      try {
        const nm = `${first.value.trim()} ${last.value.trim()}`;
        const r = await write('addScout', { first: first.value, last: last.value });
        toast(r.needsUpdate ? `Added ${nm}. The closet admin has been asked to finish their roster details.` : `Added ${nm}`);
        closeSheet(); S.scoutQ = ''; if (then) then(r.id); else render();
      } catch (er) { fail(er); btn.disabled = false; }
    } },
      sheetHead('Add a scout'),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'ffirst', text: 'First name' }), first), el('div', { class: 'field' }, el('label', { for: 'flast', text: 'Last name' }), last)),
      isRole('Admin') ? null : el('p', { class: 'mini muted', style: 'margin:0', text: "The closet admin gets a notice to add this scout's other details to the troop roster." }),
      btn);
  });
}

/* ---------- Restock ---------- */
function viewRestock() {
  if (loading()) { setAction(null); return; }
  const v = $('#view'); v.replaceChildren(); const r = S.restock;
  setSplit();
  const note = el('input', { id: 'restocknote', placeholder: 'e.g. Scout Shop order', value: r.note, autocomplete: 'off' });
  note.addEventListener('input', () => { r.note = note.value; });
  v.append(el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { for: 'restocknote', text: 'Where it came from (optional)' }), note));
  v.append(cartRows(r.cart, 'restock'));
  const confirm = async () => {
    const n = cartCount(r.cart);
    const lines = Object.entries(r.cart).map(([itemId, l]) => ({ itemId, qty: l.n, price: l.price != null && l.price !== '' ? Number(l.price) : undefined }));
    const cart = r.cart, note = r.note;
    lines.forEach(l => S.qty.set(l.itemId, qtyOf(l.itemId) + l.qty));
    r.cart = {}; r.note = ''; S.q = ''; S.pending = (S.pending || 0) + 1; renderToolbar(); render();
    toast(`Saving ${n} item${n > 1 ? 's' : ''}…`);
    try {
      const res = await send('restock', { lines, note: note.trim() });
      const undo = async () => { try { await write('undo', { logIds: res.logIds }, 'Undone'); } catch (e) { fail(e); } };
      toast(`Added ${n} item${n > 1 ? 's' : ''} to stock` + (res.priceChanges && res.priceChanges.length ? ` · new price for ${res.priceChanges.join(', ')}` : ''), undo);
    } catch (e) {
      lines.forEach(l => S.qty.set(l.itemId, qtyOf(l.itemId) - l.qty));
      if (!cartCount(r.cart)) { r.cart = cart; r.note = note; renderToolbar(); }
      toast(`Not saved: ${(e && e.message) || "couldn't reach the closet"} Your items are still in the list.`);
    } finally { S.pending--; soon(); }
  };
  summaryHook = () => {
    const n = cartCount(r.cart);
    const label = S.busy ? 'Saving…' : n ? `Add ${n} item${n > 1 ? 's' : ''} to stock` : "Tap + on what you're putting away";
    const value = Object.entries(r.cart).reduce((s, [id, l]) => s + l.n * (l.price != null && l.price !== '' ? Number(l.price) || 0 : ((S.items.get(id) || {}).cost || 0)), 0);
    setAction(label, n && value ? `${money(value)} spent` : '', confirm, !n || S.busy);
    $('#aside').replaceChildren(el('h3', { text: 'Restocking' }),
      n ? el('div', {}, Object.entries(r.cart).map(([id, l]) => { const it = S.items.get(id); return el('div', { class: 'cartline' }, el('span', { text: it ? it.name : id }), el('span', { text: '+' + l.n })); }))
        : el('p', { class: 'muted mini', text: 'Tap + on items.' }),
      el('button', { class: 'btn primary', type: 'button', disabled: !n || S.busy, onclick: confirm }, label));
  };
  summaryHook();
}

/* ---------- sheets (dialogs) ---------- */
let sheetFor = null;
function openSheet(build, wide) { sheetFor = { build, wide }; drawSheet(); }
function drawSheet() {
  const root = $('#sheetroot'); root.replaceChildren(); if (!sheetFor) return;
  const body = sheetFor.build(); if (!body) { sheetFor = null; return; }
  const bg = el('div', { class: 'sheet-bg' + (sheetFor.wide ? ' wide' : ''), onclick: e => { if (e.target === bg) closeSheet(); } },
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, body));
  root.append(bg);
}
function closeSheet() { sheetFor = null; const r = $('#sheetroot'); if (r) r.replaceChildren(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
const sheetHead = (t, sub) => el('div', { class: 'head' }, el('div', {}, el('h2', { text: t }), sub ? el('div', { class: 'muted mini', text: sub }) : null),
  el('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '×'));
async function save(action, args, msg, after) { try { const r = await write(action, args, msg); if (after) after(r); return r; } catch (e) { fail(e); } }

function itemSheet(id) {
  openSheet(() => {
    const it = S.items.get(id); if (!it) return null;
    const q = qtyOf(id), admin = isRole('Admin');
    const reorder = el('input', { id: 'reorder', type: 'number', inputmode: 'numeric', min: '0', value: String(it.reorder || 0) });
    const count = el('input', { id: 'count', type: 'number', inputmode: 'numeric', min: '0', placeholder: String(q) });
    const recent = S.log.filter(l => l.itemId === id).sort((a, b) => b.at - a.at).slice(0, 8);

    let confirmDel = false;
    const delBtn = el('button', { class: 'btn danger', type: 'button', onclick: () => {
      if (!confirmDel) { confirmDel = true; delBtn.textContent = 'Tap again to remove'; return; }
      save('updateItem', { id, active: false }, `Removed ${it.name}. Its history is kept.`, closeSheet);
    } }, 'Remove item');

    const editForm = () => {
      const name = el('input', { id: 'ename', value: it.name, autocomplete: 'off' });
      const cat = el('select', { id: 'ecat' }, CATS.map(c => el('option', { value: c, text: c }))); cat.value = it.cat;
      const cost = el('input', { id: 'ecost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: it.cost ? it.cost.toFixed(2) : '0' });
      const rule = el('select', { id: 'erule' }, RULES.map(r => el('option', { value: r, text: r }))); rule.value = it.rule;
      const eagle = el('input', { id: 'eeagle', type: 'checkbox', class: 'check' }); eagle.checked = !!it.eagleReq;
      return el('form', { class: 'stack card', onsubmit: e => { e.preventDefault(); save('updateItem', { id, name: name.value, cat: cat.value, cost: Number(cost.value) || 0, rule: rule.value, eagleReq: eagle.checked }, 'Saved'); } },
        el('h3', { text: 'Item details' }),
        el('div', { class: 'field' }, el('label', { for: 'ename', text: 'Name' }), name),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'ecat', text: 'Type' }), cat), el('div', { class: 'field' }, el('label', { for: 'ecost', text: 'Cost each' }), cost)),
        el('div', { class: 'field' }, el('label', { for: 'erule', text: 'Charge rule' }), rule),
        el('label', { class: 'row', for: 'eeagle', style: 'min-height:44px' }, eagle, el('div', { class: 'main' }, el('div', { class: 'name', text: 'Eagle required 🦅' }))),
        el('p', { class: 'mini muted', style: 'margin:0', text: 'Free: never charged. Always charge: every time. First one free: free the first time a scout gets it, charged after.' }),
        el('button', { class: 'btn', type: 'submit' }, 'Save details'));
    };

    return el('div', { style: 'display:contents' },
      sheetHead(it.name + (it.eagleReq ? ' 🦅' : ''), `${it.cat}${it.eagleReq ? ' · Eagle required' : ''} · ${it.cost > 0 ? money(it.cost) + ' · ' + it.rule : 'No cost set'}`),
      el('div', { class: 'bigqty' }, el('span', { class: 'qty', text: String(q) }), el('span', { class: 'muted', text: 'on hand' }), itemSub(it)),
      el('div', { class: 'rowbtns' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => { closeSheet(); S.tab = 'give'; S.q = it.name; S.cat = 'all'; render(true); } }, 'Give out'),
        el('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); S.tab = 'restock'; S.q = it.name; S.cat = 'all'; addToCart(S.restock.cart, id, 1); render(true); } }, 'Restock')),
      el('form', { class: 'grid2', onsubmit: async e => {
        e.preventDefault(); const t = parseInt(count.value, 10); if (isNaN(t) || t < 0) return count.focus();
        if (t === qtyOf(id)) { toast('Count already matches'); return; }
        try { const r = await write('count', { itemId: id, target: t }); toast(`${it.name} set to ${t}`, async () => { try { await write('undo', { logIds: r.logIds }, 'Undone'); } catch (er) { fail(er); } }); } catch (er) { fail(er); }
      } }, el('div', { class: 'field' }, el('label', { for: 'count', text: 'Shelf count' }), count), el('div', { class: 'field', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'submit' }, 'Set count'))),
      !admin ? null : el('form', { class: 'stack', onsubmit: e => { e.preventDefault(); save('updateItem', { id, reorder: Math.max(0, parseInt(reorder.value, 10) || 0) }, 'Saved'); } },
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'reorder', text: 'Reorder at' }), reorder), el('div', { class: 'field', style: 'justify-content:flex-end' }, el('button', { class: 'btn', type: 'submit' }, 'Save'))),
        el('p', { class: 'mini muted', style: 'margin:0', text: 'Shows as Low at or below this number. 0 = not kept in stock: never shows Low or Out.' })),
      admin ? editForm() : null,
      el('div', {}, el('h3', { text: 'Recent activity' }), recent.length ? recent.map(l => {
        const sc = l.scoutId && S.scouts.get(l.scoutId);
        return el('div', { class: 'row', style: 'min-height:44px' }, el('div', { class: 'delta ' + l.kind, text: (l.delta > 0 ? '+' : '') + l.delta }),
          el('div', { class: 'main mini', text: [sc ? sc.name : l.scoutName, l.kind === 'count' ? 'Count fix' : l.note, fmtDate(l.at)].filter(Boolean).join(' · ') }));
      }) : el('div', { class: 'muted mini', text: 'No activity yet.' })),
      admin ? delBtn : null);
  });
}

function itemForm() {
  openSheet(() => {
    const name = el('input', { id: 'iname', placeholder: 'e.g. Kayaking', autocomplete: 'off' });
    const cat = el('select', { id: 'icat' }, CATS.map(c => el('option', { value: c, text: c }))); cat.value = CATS.includes(S.cat) ? S.cat : 'Merit badge';
    const cost = el('input', { id: 'icost', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: '0' });
    const rule = el('select', { id: 'irule' }, RULES.map(r => el('option', { value: r, text: r }))); rule.value = 'First one free';
    const re = el('input', { id: 'ire', type: 'number', inputmode: 'numeric', min: '0', value: '1' });
    const start = el('input', { id: 'istart', type: 'number', inputmode: 'numeric', min: '0', value: '0' });
    return el('form', { style: 'display:contents', onsubmit: e => {
      e.preventDefault(); const nm = name.value.trim(); if (!nm) return name.focus();
      save('addItem', { name: nm, cat: cat.value, cost: Number(cost.value) || 0, rule: rule.value, reorder: parseInt(re.value, 10) || 0, startQty: parseInt(start.value, 10) || 0 }, `Added ${nm}`, closeSheet);
    } },
      sheetHead('Add item'),
      el('div', { class: 'field' }, el('label', { for: 'iname', text: 'Name' }), name),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'icat', text: 'Type' }), cat), el('div', { class: 'field' }, el('label', { for: 'icost', text: 'Cost each' }), cost)),
      el('div', { class: 'field' }, el('label', { for: 'irule', text: 'Charge rule' }), rule),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'istart', text: 'On hand now' }), start), el('div', { class: 'field' }, el('label', { for: 'ire', text: 'Reorder at' }), re)),
      el('button', { class: 'btn primary', type: 'submit' }, 'Add item'));
  });
}

/* ---------- printing ---------- */
function printNode(node, pageCss) {
  const root = $('#printroot'); root.replaceChildren(node);
  let st = document.getElementById('pagestyle');
  if (!st) { st = el('style', { id: 'pagestyle' }); document.head.append(st); }
  st.textContent = pageCss || '@page{size:letter;margin:0.5in}';
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); root.replaceChildren(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}

/* ---------- Reports ---------- */
const REPORTS = [
  ['inventory', 'Current inventory', 'Everything on the shelf, with value', null],
  ['reorder', 'Reorder list', 'What to buy on the next council run', null],
  ['activity', 'Activity', 'Given out and restocked, by date range', null],
  ['scout', 'Scout history', 'Everything one scout has received', null],
  ['charges', 'Charges', 'Money owed, and what was transferred to the treasurer', null],
  ['shrink', 'Shelf count fixes', 'Corrections from shelf counts', null],
  ['returns', 'Check back in', 'Put items nobody picked up back in stock', ['Admin']],
];
function viewReports() {
  setAction(null); if (loading()) return;
  const v = $('#view'); v.replaceChildren();
  const avail = REPORTS.filter(r => !r[3] || isRole(...r[3]));
  if (!S.report || !avail.some(r => r[0] === S.report)) {
    S.report = '';
    const pending = S.charges.filter(c => c.status === 'Pending');
    v.append(el('div', { class: 'menu' }, avail.map(([k, t, d]) => el('button', { type: 'button', class: 'row tap', onclick: () => { S.report = k; S.rep.sel = {}; render(); window.scrollTo(0, 0); } },
      el('div', { class: 'main' }, el('div', { class: 'name', text: t }), el('div', { class: 'sub', text: d })),
      k === 'charges' && pending.length ? el('span', { class: 'pill pending', text: `${pending.length} pending` }) : null,
      el('span', { class: 'muted', 'aria-hidden': 'true', text: '›' })))));
    return;
  }
  const meta = REPORTS.find(r => r[0] === S.report);
  const head = el('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap' },
    el('div', { style: 'display:flex;gap:10px;align-items:center' }, el('button', { class: 'btn small', type: 'button', onclick: () => { S.report = ''; render(); } }, '‹ Reports'), el('h2', { text: meta[1] })));
  v.append(head);
  const r = ({ inventory: repInventory, reorder: repReorder, activity: repActivity, scout: repScout, charges: repCharges, shrink: repShrink, returns: repReturns })[S.report]();
  if (r.controls) v.append(r.controls);
  if (r.kpis) v.append(el('div', { class: 'kpis' }, r.kpis.map(([k, val]) => el('div', { class: 'kpi' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: val })))));
  if (r.extra) v.append(r.extra);
  if (r.table && !r.tableHidden) v.append(el('div', { class: 'tablewrap' }, tableEl(r.table)));
  if (r.table) {
    head.append(el('div', { class: 'rowbtns', style: 'flex:none' },
      el('button', { class: 'btn small', type: 'button', onclick: () => downloadCSV(`${slug(meta[1])}-${new Date().toISOString().slice(0, 10)}.csv`, r.table) }, 'Download CSV'),
      el('button', { class: 'btn small', type: 'button', onclick: () => printNode(el('div', {}, el('h2', { text: meta[1] }), el('p', { text: [S.settings.troopName, r.subtitle, 'Printed ' + new Date().toLocaleString()].filter(Boolean).join(' · ') }), el('div', { class: 'tablewrap' }, tableEl(r.table)))) }, 'Print')));
  }
}
function tableEl(t) {
  const isNum = i => t.num && t.num.includes(i);
  return el('table', { class: 'report' },
    el('thead', {}, el('tr', {}, t.cols.map((c, i) => el('th', { class: isNum(i) ? 'num' : '', text: c })))),
    el('tbody', {}, t.rows.length ? t.rows.map(r => el('tr', { class: r._class || '' }, r.map((c, i) => el('td', { class: (isNum(i) ? 'num' : '') + (t.wrap && t.wrap.includes(i) ? ' wrap' : ''), text: c == null ? '' : String(c) }))))
      : el('tr', {}, el('td', { colspan: t.cols.length, class: 'muted', text: 'Nothing to show.' }))),
    t.total ? el('tfoot', {}, el('tr', { class: 'total' }, t.total.map((c, i) => el('td', { class: isNum(i) ? 'num' : '', text: c == null ? '' : String(c) })))) : null);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); }
function downloadCSV(name, t) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [t.cols, ...t.rows, ...(t.total ? [t.total] : [])].map(r => r.map(esc).join(','));
  downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
}
function repInventory() {
  const items = activeItems().sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat) || byName(a, b));
  const rows = items.map(i => { const q = qtyOf(i.id); return [i.name, i.cat, q, money(i.cost), money(Math.max(0, q) * i.cost), ({ ok: 'OK', low: 'Low', out: 'Out' })[status(i)]]; });
  const value = items.reduce((s, i) => s + Math.max(0, qtyOf(i.id)) * i.cost, 0);
  const units = items.reduce((s, i) => s + Math.max(0, qtyOf(i.id)), 0);
  return {
    kpis: [['Items', items.length], ['On the shelf', units], ['Shelf value', money(value)], ['Low or out', items.filter(i => status(i) !== 'ok').length]],
    table: { cols: ['Item', 'Category', 'On hand', 'Cost', 'Value', 'Status'], num: [2, 3, 4], rows, total: ['Total', '', units, '', money(value), ''] },
  };
}
function repReorder() {
  const items = activeItems().filter(i => status(i) !== 'ok').sort(byName);
  // Suggest buying enough to get back to twice the reorder level.
  const target = i => i.reorder * 2;
  const rows = items.map(i => { const q = qtyOf(i.id), need = Math.max(target(i) - q, 0); return [i.name, i.cat, q, i.reorder, need, money(need * i.cost)]; });
  const units = rows.reduce((s, r) => s + r[4], 0), cost = items.reduce((s, i) => s + Math.max(target(i) - qtyOf(i.id), 0) * i.cost, 0);
  return {
    subtitle: 'Items at or below their reorder level',
    kpis: [['Items to buy', items.length], ['Units', units], ['Estimated cost', money(cost)]],
    table: { cols: ['Item', 'Category', 'On hand', 'Reorder at', 'Buy', 'Est. cost'], num: [2, 3, 4, 5], rows, total: ['Total', '', '', '', units, money(cost)] },
  };
}
function rangeBounds() {
  const now = new Date(), r = S.rep.range, end = Date.now() + 1;
  if (r === 'custom') { const f = S.rep.from ? new Date(S.rep.from + 'T00:00:00').getTime() : 0; const t = S.rep.to ? new Date(S.rep.to + 'T23:59:59').getTime() : end; return [f, t]; }
  if (r === 'year') return [new Date(now.getFullYear(), 0, 1).getTime(), end];
  if (r === 'all') return [0, end];
  return [Date.now() - Number(r) * 864e5, end];
}
function rangeControls(extra) {
  const range = el('select', { id: 'rrange' }, [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['year', 'This year'], ['all', 'All time'], ['custom', 'Pick dates']].map(([k, l]) => el('option', { value: k, text: l })));
  range.value = S.rep.range; range.onchange = () => { S.rep.range = range.value; render(); };
  const box = el('div', { class: 'reportbar' }, el('div', { class: 'field' }, el('label', { for: 'rrange', text: 'Dates' }), range));
  if (S.rep.range === 'custom') {
    const f = el('input', { id: 'rfrom', type: 'date', value: S.rep.from }), t = el('input', { id: 'rto', type: 'date', value: S.rep.to });
    f.onchange = () => { S.rep.from = f.value; render(); }; t.onchange = () => { S.rep.to = t.value; render(); };
    box.append(el('div', { class: 'field' }, el('label', { for: 'rfrom', text: 'From' }), f), el('div', { class: 'field' }, el('label', { for: 'rto', text: 'To' }), t));
  }
  if (extra) box.append(extra);
  return box;
}
function repActivity() {
  const [from, to] = rangeBounds();
  const rows0 = S.log.filter(l => l.at >= from && l.at <= to && l.kind !== 'count');
  const grp = el('select', { id: 'rgroup' }, [['item', 'By item'], ['scout', 'By scout'], ['none', 'Every entry']].map(([k, l]) => el('option', { value: k, text: l })));
  grp.value = S.rep.group; grp.onchange = () => { S.rep.group = grp.value; render(); };
  const controls = rangeControls(el('div', { class: 'field' }, el('label', { for: 'rgroup', text: 'Show' }), grp));
  const out = rows0.filter(isGive), inn = rows0.filter(l => l.kind === 'in');
  const kpis = [['Given out', out.reduce((s, l) => s - l.delta, 0)], ['Restocked', inn.reduce((s, l) => s + l.delta, 0)], ['Scouts served', new Set(out.filter(l => l.kind === 'out').map(l => l.scoutId)).size]];
  const iname = l => (S.items.get(l.itemId) || {}).name || l.itemName, sname = l => (S.scouts.get(l.scoutId) || {}).name || l.scoutName;
  let table;
  if (S.rep.group === 'none') {
    table = { cols: ['Date', 'Item', 'Change', 'Scout', 'Note', 'Logged by'], num: [2], wrap: [4],
      rows: rows0.sort((a, b) => b.at - a.at).map(l => [fmtShort(l.at), iname(l), (l.delta > 0 ? '+' : '') + l.delta, sname(l), l.note, leaderName(l.by)]) };
  } else if (S.rep.group === 'scout') {
    const m = new Map();
    out.forEach(l => { const k = l.scoutId; const e = m.get(k) || { name: sname(l), n: 0, items: new Map() }; e.n -= l.delta; e.items.set(iname(l), (e.items.get(iname(l)) || 0) - l.delta); m.set(k, e); });
    m.forEach(e => { for (const [k, n] of e.items) if (n <= 0) e.items.delete(k); });
    table = { cols: ['Scout', 'Items received', 'What'], num: [1], wrap: [2],
      rows: [...m.values()].sort((a, b) => a.name.localeCompare(b.name)).map(e => [e.name, e.n, [...e.items].map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join(', ')]) };
  } else {
    const m = new Map();
    rows0.forEach(l => { const e = m.get(l.itemId) || { name: iname(l), out: 0, in: 0 }; if (isGive(l)) e.out -= l.delta; else e.in += l.delta; m.set(l.itemId, e); });
    const rows = [...m.values()].sort((a, b) => b.out - a.out || a.name.localeCompare(b.name)).map(e => [e.name, e.out, e.in]);
    table = { cols: ['Item', 'Given out', 'Restocked'], num: [1, 2], rows, total: ['Total', kpis[0][1], kpis[1][1]] };
  }
  return { controls, kpis, table, subtitle: controls.querySelector('select').selectedOptions[0].textContent };
}
function repScout() {
  const sel = el('select', { id: 'rscout' }, el('option', { value: '', text: 'Pick a scout' }), [...S.scouts.values()].sort(byName).map(s => el('option', { value: s.id, text: s.name + (s.active ? '' : ' (archived)') })));
  sel.value = S.rep.scout; sel.onchange = () => { S.rep.scout = sel.value; render(); };
  const controls = el('div', { class: 'reportbar' }, el('div', { class: 'field' }, el('label', { for: 'rscout', text: 'Scout' }), sel));
  const id = S.rep.scout; if (!id) return { controls };
  const s = S.scouts.get(id);
  const got = S.log.filter(l => l.scoutId === id && l.kind === 'out').sort((a, b) => b.at - a.at);
  const kept = got.filter(l => !S.returned.has(l.id));
  const ch = S.charges.filter(c => c.scoutId === id);
  const chargeFor = l => ch.find(c => c.logId === l.id);
  const showMoney = true;
  return {
    controls, subtitle: s ? s.name : '',
    kpis: [['Items received', kept.reduce((a, l) => a - l.delta, 0)], ...(showMoney ? [['Pending charges', money(ch.filter(c => c.status === 'Pending').reduce((a, c) => a + c.amount, 0))], ['Transferred to Treasurer', money(ch.filter(c => c.status === 'Transferred to Treasurer').reduce((a, c) => a + c.amount, 0))]] : [])],
    table: { cols: ['Date', 'Item', 'Qty', 'Charge', 'Status'], num: [2, 3],
      rows: got.map(l => { const c = chargeFor(l); return [fmtShort(l.at), ((S.items.get(l.itemId) || {}).name || l.itemName) + (S.returned.has(l.id) ? ' (checked back in)' : ''), -l.delta, c ? money(c.amount) : '', c ? c.status + (c.reason ? ` (${c.reason})` : '') : '']; }) },
  };
}
function repCharges() {
  const st = S.rep.status;
  const tabs = el('div', { class: 'chips', style: 'margin-top:12px' }, ['Pending', 'Transferred to Treasurer', 'Waived', 'All'].map(k => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(st === k), onclick: () => { S.rep.status = k; S.rep.sel = {}; render(); } },
    k + (k !== 'All' ? ` (${S.charges.filter(c => c.status === k).length})` : ''))));
  const list = S.charges.filter(c => st === 'All' || c.status === st).sort((a, b) => a.scoutName.localeCompare(b.scoutName) || a.at - b.at);
  const total = list.reduce((s, c) => s + c.amount, 0);
  const sel = S.rep.sel, selIds = Object.keys(sel).filter(k => sel[k]);
  const extra = el('div', {}), manage = isRole('Admin', 'Treasurer');
  if (!manage) extra.append(el('p', { class: 'mini muted', style: 'margin:12px 2px 0', text: 'Only the closet admin and treasurer can mark charges transferred or waived.' }));
  if (manage && st === 'Pending' && list.length) {
    const reason = el('input', { id: 'waivewhy', placeholder: 'Reason for waiving', autocomplete: 'off' });
    extra.append(el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('div', { class: 'mini muted', text: selIds.length ? `${selIds.length} selected · ${money(list.filter(c => sel[c.id]).reduce((s, c) => s + c.amount, 0))}` : 'Tick the charges you are sending to the treasurer, then mark them transferred.' }),
      el('div', { class: 'rowbtns' },
        el('button', { class: 'btn small', type: 'button', onclick: () => { list.forEach(c => { sel[c.id] = true; }); render(); } }, 'Select all'),
        el('button', { class: 'btn primary', type: 'button', disabled: !selIds.length || S.busy, onclick: () => save('setChargeStatus', { ids: selIds, status: 'Transferred to Treasurer' }, `${selIds.length} transferred to the treasurer`, () => { S.rep.sel = {}; }) }, 'Mark transferred to Treasurer')),
      el('div', { class: 'searchrow' }, reason, el('button', { class: 'btn', type: 'button', disabled: !selIds.length || S.busy, onclick: () => {
        if (!reason.value.trim()) { toast('Add a reason for waiving.'); reason.focus(); return; }
        save('setChargeStatus', { ids: selIds, status: 'Waived', reason: reason.value.trim() }, `Waived ${selIds.length}`, () => { S.rep.sel = {}; });
      } }, 'Waive'))));
  }
  if (manage && st === 'Transferred to Treasurer' && list.length) extra.append(el('div', { class: 'card rowbtns', style: 'margin-top:12px;align-items:center' },
    el('span', { class: 'mini muted', style: 'flex:2', text: selIds.length ? `${selIds.length} selected` : 'Marked by mistake? Tick it and set it back to pending.' }),
    el('button', { class: 'btn small', type: 'button', disabled: !selIds.length || S.busy, onclick: () => save('setChargeStatus', { ids: selIds, status: 'Pending' }, `${selIds.length} back to pending`, () => { S.rep.sel = {}; }) }, 'Back to pending')));
  // Grouped by scout, with checkboxes for pending and transferred.
  const byScout = new Map(); list.forEach(c => { const a = byScout.get(c.scoutName) || []; a.push(c); byScout.set(c.scoutName, a); });
  const body = el('div', { class: 'list' });
  for (const [name, cs] of byScout) {
    const sum = cs.reduce((s, c) => s + c.amount, 0);
    body.append(el('div', { class: 'group-h', style: 'display:flex;justify-content:space-between' }, el('span', { text: name }), el('span', { text: money(sum) })));
    cs.forEach(c => {
      const box = manage && (st === 'Pending' || st === 'Transferred to Treasurer') ? el('input', { type: 'checkbox', class: 'check', 'aria-label': `Select ${c.itemName} for ${name}` }) : null;
      if (box) { box.checked = !!sel[c.id]; box.onchange = () => { sel[c.id] = box.checked; render(); }; }
      body.append(el('label', { class: 'row', style: 'min-height:52px' }, box,
        el('div', { class: 'main' }, el('div', { class: 'name', text: `${c.itemName}${c.qty > 1 ? ' ×' + c.qty : ''}` }),
          el('div', { class: 'sub' }, el('span', { text: fmtDate(c.at) }), el('span', { class: 'pill ' + c.status.toLowerCase().replace(/\s+/g, '-'), text: c.status }),
            c.reason ? el('span', { text: c.reason }) : null, c.changedBy && c.status !== 'Pending' ? el('span', { text: `by ${leaderName(c.changedBy)} ${c.changedAt ? fmtShort(c.changedAt) : ''}` }) : null)),
        el('div', { class: 'qty', style: 'font-size:1.2rem', text: money(c.amount) })));
    });
  }
  if (!list.length) body.append(el('div', { class: 'empty', text: st === 'Pending' ? 'No pending charges. Nothing to hand to the treasurer.' : 'Nothing here.' }));
  extra.append(body);
  return {
    controls: tabs, extra, subtitle: st + ' charges',
    kpis: [['Charges', list.length], ['Total', money(total)], ['Scouts', byScout.size]],
    tableHidden: true,
    table: { cols: ['Scout', 'Date', 'Item', 'Qty', 'Amount', 'Status', 'Reason', 'Changed by'], num: [3, 4], wrap: [6],
      rows: list.map(c => [c.scoutName, fmtShort(c.at), c.itemName, c.qty, money(c.amount), c.status, c.reason, c.changedBy ? leaderName(c.changedBy) : '']),
      total: ['Total', '', '', '', money(total), '', '', ''] },
  };
}
function repShrink() {
  const [from, to] = rangeBounds();
  const rows0 = S.log.filter(l => l.kind === 'count' && l.at >= from && l.at <= to && l.note !== 'Starting count');
  const m = new Map(); rows0.forEach(l => { const e = m.get(l.itemId) || { name: (S.items.get(l.itemId) || {}).name || l.itemName, net: 0, n: 0, cost: (S.items.get(l.itemId) || {}).cost || l.unitCost }; e.net += l.delta; e.n++; m.set(l.itemId, e); });
  const rows = [...m.values()].sort((a, b) => a.net - b.net).map(e => [e.name, e.n, (e.net > 0 ? '+' : '') + e.net, money(e.net * e.cost)]);
  const missing = [...m.values()].filter(e => e.net < 0).reduce((s, e) => s - e.net * e.cost, 0);
  return { controls: rangeControls(), kpis: [['Count fixes', rows0.length], ['Missing value', money(missing)]],
    table: { cols: ['Item', 'Fixes', 'Net change', 'Value'], num: [1, 2, 3], rows } };
}

/* ---------- More ---------- */
function viewMore() {
  setAction(null); if (loading()) return;
  const v = $('#view'); v.replaceChildren();
  const sub = S.sub;
  if (sub) {
    v.append(el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn small', type: 'button', onclick: () => { S.sub = ''; render(); } }, '‹ More')));
    ({ scouts: viewScouts, history: viewHistory, admin: viewAdmin, share: viewShare, paper: viewPaper })[sub](v);
    return;
  }
  const items = [
    ['history', 'History', 'Recent entries, and undo your own'],
    ['paper', 'Print paper log', 'For leaders who would rather write it down'],
    ['share', 'Share the app', 'QR code and link for other leaders'],
    ...(isRole('Admin') ? [['admin', 'Leaders & access', 'Who can sign in, and their roles']] : []),
  ];
  v.append(el('div', { class: 'menu' }, items.map(([k, t, d]) => el('button', { type: 'button', class: 'row tap', onclick: () => { S.sub = k; render(); window.scrollTo(0, 0); } },
    el('div', { class: 'main' }, el('div', { class: 'name', text: t }), el('div', { class: 'sub', text: d })), el('span', { class: 'muted', 'aria-hidden': 'true', text: '›' })))));
  v.append(el('div', { class: 'menu' },
    S.sheetUrl ? el('a', { class: 'row tap', href: S.sheetUrl, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' }, el('div', { class: 'main' }, el('div', { class: 'name', text: 'Open the Google Sheet' }), el('div', { class: 'sub', text: 'Admins only' })), el('span', { class: 'muted', text: '↗' })) : null,
    el('button', { type: 'button', class: 'row tap', onclick: signOut }, el('div', { class: 'main' }, el('div', { class: 'name', text: 'Sign out' }), el('div', { class: 'sub', text: S.me ? S.me.email : '' })))));
}

function viewScoutsTab() { setAction(null); if (loading()) return; const v = $('#view'); v.replaceChildren(); viewScouts(v, true); }
function viewScouts(v, asTab) {
  const got = new Map(); for (const l of S.log) if (isGive(l) && l.scoutId) got.set(l.scoutId, (got.get(l.scoutId) || 0) - l.delta);
  const money_ = true, owes = new Map();
  if (money_) for (const c of S.charges) if (c.status === 'Pending') owes.set(c.scoutId, (owes.get(c.scoutId) || 0) + c.amount);
  const q = asTab ? String(S.scoutListQ || '').trim().toLowerCase() : '';
  const list = el('div', { class: 'list' }), sc = activeScouts().filter(s => !q || s.name.toLowerCase().includes(q));
  if (!sc.length) list.append(el('div', { class: 'empty' }, el('strong', { text: 'No scouts yet' }), el('span', { text: 'Add scouts here or while giving out items.' })));
  for (const s of sc) list.append(el('button', { type: 'button', class: 'row tap', onclick: () => scoutSheet(s.id) },
    el('div', { class: 'main' }, el('div', { class: 'name', text: s.name }), el('div', { class: 'sub', text: `${got.get(s.id) || 0} items received` })),
    owes.get(s.id) ? el('span', { class: 'pill pending', text: `Owes ${money(owes.get(s.id))}` }) : null, el('span', { class: 'muted', 'aria-hidden': 'true', text: '›' })));
  if (q && !sc.length) list.append(el('div', { class: 'empty', text: 'No scout by that name.' }));
  const review = isRole('Admin') ? [...S.scouts.values()].filter(s => s.needsUpdate).sort(byName) : [];
  if (!asTab) v.append(el('h2', { style: 'margin-top:12px', text: 'Scouts' }));
  if (money_ && owes.size) v.append(el('p', { class: 'muted mini', style: 'margin:12px 2px 0', text: `${owes.size} scout${owes.size > 1 ? 's owe' : ' owes'} ${money([...owes.values()].reduce((a, b) => a + b, 0))} in pending charges` }));
  if (review.length) {
    v.append(el('div', { class: 'card stack', style: 'margin-top:12px;border-color:var(--warn-fg)' },
      el('h3', { style: 'color:var(--warn-fg)', text: `Needs roster update (${review.length})` }),
      el('p', { class: 'mini muted', style: 'margin:0', text: "Leaders added these scouts with just a name. Update their details on the troop roster, then mark them updated." }),
      review.map(s => el('div', { class: 'row', style: 'min-height:52px' },
        el('div', { class: 'main' }, el('div', { class: 'name', text: s.name }), el('div', { class: 'sub', text: [`added by ${leaderName(s.addedBy)}`, s.addedAt ? fmtDate(s.addedAt) : ''].filter(Boolean).join(' · ') })),
        el('button', { class: 'btn small', type: 'button', onclick: () => save('updateScout', { id: s.id, updated: true }, `${s.name} marked updated`) }, 'Mark updated')))));
  }
  v.append(addScoutButton(''), list);
  const arch = [...S.scouts.values()].filter(s => !s.active).sort(byName);
  if (arch.length) { v.append(el('div', { class: 'group-h', text: 'Archived' })); arch.forEach(s => v.append(el('button', { type: 'button', class: 'row tap', onclick: () => scoutSheet(s.id) }, el('div', { class: 'main' }, el('div', { class: 'name muted', text: s.name }))))); }
}
function scoutSheet(id) {
  openSheet(() => {
    const s = S.scouts.get(id); if (!s) return null;
    const nameParts = s.name.split(/\s+/);
    const first = el('input', { id: 'ffirst', value: s.first || nameParts[0] || '', autocomplete: 'off' }), last = el('input', { id: 'flast', value: s.last || nameParts.slice(1).join(' '), autocomplete: 'off' });
    const recv = S.log.filter(l => l.scoutId === id && l.kind === 'out').sort((a, b) => b.at - a.at);
    const ch = S.charges.filter(c => c.scoutId === id), pend = ch.filter(c => c.status === 'Pending').reduce((a, c) => a + c.amount, 0);
    return el('div', { style: 'display:contents' },
      sheetHead(s.name, [pend ? `${money(pend)} pending charges` : ''].filter(Boolean).join(' · ')),
      el('button', { class: 'btn primary', type: 'button', disabled: !s.active, onclick: () => { closeSheet(); S.give.scoutId = id; S.give.cart = {}; S.tab = 'give'; S.q = ''; render(true); } }, `Give items to ${s.name}`),
      ch.length ? (() => {
        const p = ch.filter(c => c.status === 'Pending').sort((a, b) => b.at - a.at), t = ch.filter(c => c.status === 'Transferred to Treasurer'), sum = l => money(l.reduce((a, c) => a + c.amount, 0));
        return el('div', { class: 'card stack' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' }, el('h3', { text: 'Owes' }), el('strong', { style: 'font-size:1.3rem', text: sum(p) })),
          p.length ? p.map(c => el('div', { class: 'row', style: 'min-height:40px' }, el('div', { class: 'main' }, el('div', { class: 'name', text: `${c.itemName}${c.qty > 1 ? ' ×' + c.qty : ''}` }), el('div', { class: 'sub', text: fmtDate(c.at) })), el('div', { text: money(c.amount) }))) : el('div', { class: 'muted mini', text: 'Nothing pending.' }),
          t.length ? el('div', { class: 'mini muted', text: `Transferred to Treasurer: ${sum(t)} (${t.length})` }) : null);
      })() : null,
      el('div', {}, el('h3', { text: `Received (${recv.filter(l => !S.returned.has(l.id)).reduce((a, l) => a - l.delta, 0)})` }), recv.length ? recv.map(l => {
        const it = S.items.get(l.itemId), c = ch.find(x => x.logId === l.id), back = S.returned.has(l.id);
        const canReturn = isRole('Admin') && !back && !(c && c.status === 'Transferred to Treasurer');
        return el('div', { class: 'row', style: 'min-height:44px' }, el('div', { class: 'main' }, el('div', { class: 'name' + (back ? ' muted' : ''), text: (it ? it.name : l.itemName) + (l.delta < -1 ? ` ×${-l.delta}` : '') }),
          el('div', { class: 'sub' }, el('span', { text: fmtDate(l.at) }), back ? el('span', { class: 'pill', text: 'Checked back in' }) : null, c && !back ? el('span', { class: 'pill ' + c.status.toLowerCase().replace(/\s+/g, '-'), text: `${c.status} ${money(c.amount)}` }) : null)),
          canReturn ? el('button', { class: 'btn small', type: 'button', onclick: () => save('checkIn', { logIds: [l.id] }, `${it ? it.name : l.itemName} checked back in`) }, 'Check back in') : null);
      }) : el('div', { class: 'muted mini', text: 'Nothing given out yet.' })),
      s.needsUpdate && isRole('Admin') ? el('div', { class: 'card stack', style: 'border-color:var(--warn-fg)' },
        el('div', { class: 'mini', text: `Added by ${leaderName(s.addedBy)}${s.addedAt ? ' on ' + fmtDate(s.addedAt) : ''}. Their roster details still need updating.` }),
        el('button', { class: 'btn', type: 'button', onclick: () => save('updateScout', { id, updated: true }, `${s.name} marked updated`) }, 'Mark roster updated')) : null,
      isRole('Admin') ? el('form', { class: 'stack', onsubmit: e => { e.preventDefault(); if (!first.value.trim()) return first.focus(); if (!last.value.trim()) return last.focus(); save('updateScout', { id, first: first.value, last: last.value }, 'Saved'); } },
        el('h3', { text: 'Edit scout' }),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'ffirst', text: 'First name' }), first), el('div', { class: 'field' }, el('label', { for: 'flast', text: 'Last name' }), last)),
        el('div', { class: 'rowbtns' }, el('button', { class: 'btn', type: 'submit' }, 'Save'),
          el('button', { class: 'btn danger', type: 'button', onclick: () => save('updateScout', { id, active: !s.active }, s.active ? `${s.name} archived. History is kept.` : `${s.name} restored`, closeSheet) }, s.active ? 'Archive scout' : 'Restore scout'))) : null);
  });
}

function viewHistory(v) {
  const rows = [...S.log].sort((a, b) => b.at - a.at).slice(0, 200), list = el('div', { class: 'list' });
  if (!rows.length) list.append(el('div', { class: 'empty', text: 'Nothing logged yet.' }));
  let day = '';
  for (const l of rows) {
    const d = fmtDate(l.at); if (d !== day) { day = d; list.append(el('div', { class: 'group-h', text: d })); }
    const it = S.items.get(l.itemId), sc = l.scoutId && S.scouts.get(l.scoutId);
    const mine = l.by === (S.me && S.me.email) && Date.now() - l.at < 864e5;
    const canUndo = isRole('Admin') || mine;
    const main = el('div', { class: 'main' }, el('div', { class: 'name', text: (it ? it.name : l.itemName) + ((sc || l.scoutName) ? ' → ' + (sc ? sc.name : l.scoutName) : '') }),
      el('div', { class: 'sub' }, el('span', { text: fmtTime(l.at) }), l.kind === 'count' ? el('span', { text: 'Count fix' }) : null, l.note ? el('span', { text: '· ' + l.note }) : null, el('span', { text: '· ' + leaderName(l.by) })));
    const right = !canUndo ? null : S.pendingDel === l.id
      ? el('div', { class: 'confirm' }, el('button', { class: 'btn small danger', type: 'button', onclick: () => { S.pendingDel = null; removeEntries([l.id], 'Entry removed. Stock updated.'); } }, 'Remove'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { S.pendingDel = null; render(); } }, 'Keep'))
      : el('button', { class: 'btn small', type: 'button', 'aria-label': 'Remove this entry', onclick: () => { S.pendingDel = l.id; render(); } }, '✕');
    list.append(el('div', { class: 'row' }, el('div', { class: 'delta ' + l.kind, text: (l.delta > 0 ? '+' : '') + l.delta }), main, right));
  }
  v.append(el('h2', { style: 'margin-top:12px', text: 'History' }),
    el('p', { class: 'mini muted', text: isRole('Admin') ? 'As admin you can remove any entry. Entries whose charge was transferred to the treasurer can only be removed after the charge is set back to pending.' : 'You can remove your own entries for 24 hours.' }), list);
}

function viewShare(v) {
  const url = location.origin + location.pathname;
  const qrSvg = poster => { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); return el('div', { html: q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }), style: poster ? 'width:4.5in;height:4.5in;margin:0 auto' : 'background:#fff;padding:12px;border-radius:12px;max-width:280px;margin:0 auto' }); };
  const urlBox = el('input', { id: 'shareurl', class: 'search', value: url, readonly: true });
  v.append(el('h2', { style: 'margin-top:12px', text: 'Share the app' }),
    el('div', { class: 'card stack', style: 'margin-top:12px;text-align:center' }, qrSvg(),
      el('p', { class: 'mini muted', style: 'margin:0', text: 'Leaders scan this with their phone camera, sign in with Google, then add the app to their home screen. Only people on the leader list can get in.' }),
      el('div', { class: 'searchrow' }, urlBox, el('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch (e) { urlBox.select(); } } }, 'Copy')),
      el('button', { class: 'btn', type: 'button', onclick: () => printNode(el('div', { class: 'poster' }, el('h2', { text: S.settings.appTitle || 'Troop Closet' }), qrSvg(true), el('p', { text: 'Scan to open. Leaders sign in with Google.' }), el('p', { text: url }))) }, 'Print a QR poster')),
    el('div', { class: 'card stack', style: 'margin-top:12px' }, el('h3', { text: 'Add to home screen' }),
      el('p', { class: 'mini', style: 'margin:0', text: 'iPhone: open the link in Safari, tap Share, then Add to Home Screen.' }),
      el('p', { class: 'mini', style: 'margin:0', text: 'Android: open the link in Chrome, tap ⋮, then Add to Home screen (or Install app).' })));
}

function viewAdmin(v) {
  const list = el('div', { class: 'list' });
  const rows = [...S.leaders].sort((a, b) => (b.active - a.active) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || (a.name || a.email).localeCompare(b.name || b.email));
  rows.forEach(l => list.append(el('button', { type: 'button', class: 'row tap', onclick: () => leaderSheet(l.email) },
    el('div', { class: 'main' }, el('div', { class: 'name' + (l.active ? '' : ' muted'), text: l.name || l.email }), el('div', { class: 'sub' }, el('span', { text: l.email }), l.active ? null : el('span', { text: '· removed' }))),
    el('span', { class: 'pill' + (l.role === 'Admin' ? ' eagle' : l.role === 'Treasurer' ? ' pending' : ''), text: l.role }))));
  v.append(el('h2', { style: 'margin-top:12px', text: 'Leaders & access' }),
    el('p', { class: 'mini muted', text: 'People sign in with the Google account listed here. Leader: give out, restock, reports, and see charges. Treasurer: also marks charges transferred or waived. Admin: everything, including items, costs and this list.' }),
    el('button', { class: 'btn primary', type: 'button', onclick: () => leaderSheet('') }, '+ Add a leader'), list);
}
function leaderSheet(email) {
  openSheet(() => {
    const l = S.leaders.find(x => x.email === email) || { email: '', name: '', role: 'Leader', active: true };
    const em = el('input', { id: 'lemail', type: 'email', value: l.email, placeholder: 'name@gmail.com', autocomplete: 'off', readonly: !!email });
    const nm = el('input', { id: 'lname', value: l.name, placeholder: 'Name shown in the app', autocomplete: 'off' });
    const role = el('select', { id: 'lrole' }, ROLES.map(r => el('option', { value: r, text: r }))); role.value = l.role;
    const active = el('input', { id: 'lactive', type: 'checkbox', class: 'check' }); active.checked = l.active;
    return el('form', { style: 'display:contents', onsubmit: e => { e.preventDefault(); save('saveLeader', { email: em.value.trim(), name: nm.value.trim(), role: role.value, active: active.checked }, 'Saved', closeSheet); } },
      sheetHead(email ? (l.name || l.email) : 'Add a leader'),
      el('div', { class: 'field' }, el('label', { for: 'lemail', text: 'Google account email' }), em),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'lname', text: 'Name' }), nm), el('div', { class: 'field' }, el('label', { for: 'lrole', text: 'Role' }), role)),
      el('label', { class: 'row', for: 'lactive', style: 'min-height:48px' }, active, el('div', { class: 'main' }, el('div', { class: 'name', text: 'Can sign in' }), el('div', { class: 'sub', text: 'Untick to remove access. They are signed out everywhere.' }))),
      el('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      email ? el('button', { class: 'btn', type: 'button', onclick: () => save('signOutEverywhere', { email }, `Signed ${l.name || email} out on every device`, closeSheet) }, 'Sign out everywhere') : null);
  });
}

/* ---------- Check back in ---------- */
function groupBy(list, fn) { const m = new Map(); list.forEach(x => { const k = fn(x); m.set(k, (m.get(k) || []).concat(x)); }); return [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0]))); }
const dayKey = t => new Date(t).toDateString();
const scoutNameOf = l => (S.scouts.get(l.scoutId) || {}).name || l.scoutName;
const itemNameOf = l => (S.items.get(l.itemId) || {}).name || l.itemName;

function repReturns() {
  return { extra: retEnvelopes() };
}

/** Give-outs from the last year that haven't been checked back in, by day. */
function retEnvelopes() {
  const R = S.ret, wrap = el('div', { class: 'stack', style: 'margin-top:12px' });
  const since = Date.now() - 365 * 864e5;
  const recent = S.log.filter(l => l.kind === 'out' && l.scoutId && l.at >= since && !S.returned.has(l.id)).sort((a, b) => b.at - a.at);
  wrap.append(el('p', { class: 'mini muted', style: 'margin:0', text: 'Everything given out in the last year. When you clean out envelopes nobody picked up, tick them and check them back in to stock.' }));
  if (!recent.length) { wrap.append(el('div', { class: 'empty', text: 'Nothing given out in the last year.' })); return wrap; }
  const days = [...new Map(recent.map(l => [dayKey(l.at), l.at])).entries()];
  if (R.day !== 'all' && !days.some(([k]) => k === R.day)) R.day = days[0][0];
  const list = R.day === 'all' ? recent : recent.filter(l => dayKey(l.at) === R.day);
  wrap.append(el('div', { class: 'chips' }, [...days.slice(0, 12).map(([k, t]) => [k, fmtShort(t)]), ['all', 'All']].map(([k, l]) =>
    el('button', { type: 'button', class: 'chip', 'aria-pressed': String(R.day === k), onclick: () => { R.day = k; R.sel = {}; render(); } }, l))));
  const sel = R.sel, ids = list.filter(l => sel[l.id]).map(l => l.id);
  const done = () => { R.sel = {}; render(); };
  const sec = el('div', { class: 'stack', style: 'gap:12px' }); wrap.append(sec);
  {
    for (const [name, items] of groupBy(list, scoutNameOf)) {
      const all = items.every(l => sel[l.id]);
      sec.append(el('div', { class: 'card', style: 'padding:6px 12px' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:6px' },
        el('strong', { text: name }), el('button', { class: 'linkbtn', type: 'button', onclick: () => { items.forEach(l => { sel[l.id] = !all; }); render(); } }, all ? 'Clear' : 'Select all')),
        items.map(l => { const cb = el('input', { type: 'checkbox', class: 'check', 'aria-label': `Select ${itemNameOf(l)} for ${name}` }); cb.checked = !!sel[l.id]; cb.onchange = () => { sel[l.id] = cb.checked; render(); };
          return el('label', { class: 'row', style: 'min-height:48px' }, cb, el('div', { class: 'main' }, el('div', { class: 'name', text: itemNameOf(l) + (l.delta < -1 ? ` ×${-l.delta}` : '') }),
            el('div', { class: 'sub' }, el('span', { text: fmtShort(l.at) }), l.note ? el('span', { text: l.note }) : null))); })));
    }
  }
  sec.append(el('div', { class: 'card rowbtns cohbar', style: 'position:sticky;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom,0px) + 8px);z-index:4;box-shadow:0 -4px 16px rgba(0,0,0,.08)' },
    el('span', { class: 'mini ' + (ids.length ? '' : 'muted'), style: 'flex:1 1 100%;font-weight:600', text: ids.length ? `${ids.length} selected` : 'Tick items that were never picked up' }),
    el('button', { class: 'btn small primary', type: 'button', disabled: !ids.length, onclick: () => save('checkIn', { logIds: ids }, `${ids.length} checked back in to stock`, done) }, ids.length ? `Check ${ids.length} back in` : 'Check back in')));
  return wrap;
}

/* ---------- paper log ---------- */
function viewPaper(v) {
  const pages = el('input', { id: 'pages', type: 'number', min: '1', max: '20', value: '1', inputmode: 'numeric', style: 'max-width:120px' });
  v.append(el('h2', { style: 'margin-top:12px', text: 'Paper log' }),
    el('div', { class: 'card stack', style: 'margin-top:12px' },
      el('p', { style: 'margin:0', text: 'A sheet to keep in the closet for anyone who would rather not use the app. One item per line; RETURN before the item name for anything put back. Snap a photo of filled-in pages and send it to whoever enters them.' }),
      el('div', { class: 'field' }, el('label', { for: 'pages', text: 'Pages' }), pages),
      el('button', { class: 'btn primary', type: 'button', onclick: () => printNode(paperLog(Math.max(1, Math.min(20, parseInt(pages.value, 10) || 1))), '@page{size:letter portrait;margin:0.4in}') }, 'Print')));
}
function paperLog(n) {
  const cols = [['Date', '11%'], ['Scout (first and last name)', '28%'], ['Item', '33%'], ['Qty', '7%'], ['Leader', '13%'], ['Recorded', '8%']];
  const cell = 'border:1px solid #000;padding:0 6px;height:0.36in;font:10pt system-ui,sans-serif;text-align:left';
  const page = () => el('div', { style: 'break-after:page;color:#000' },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px' },
      el('div', { style: 'font:700 18pt system-ui,sans-serif', text: [S.settings.troopName, 'Advancement closet log'].filter(Boolean).join(' · ') })),
    el('div', { style: 'font:10pt system-ui,sans-serif;margin-bottom:6px', text: 'Write clearly, one item per line. Putting something back on the shelf? Write RETURN before the item name, e.g. "RETURN Cooking". Leave Recorded blank; it gets ticked once the advancement team records it in the inventory system.' }),
    el('table', { style: 'border-collapse:collapse;width:calc(100% - 2px);table-layout:fixed' },
      el('colgroup', {}, cols.map(([, w]) => el('col', { style: 'width:' + w }))),
      el('thead', {}, el('tr', {}, cols.map(([t]) => el('th', { style: cell + ';background:#eee;font-weight:700;height:0.3in' + (t === 'Recorded' ? ';font-size:8pt;padding:0 3px;text-align:center' : ''), text: t })))),
      el('tbody', {}, Array.from({ length: 23 }, (_, i) => el('tr', {}, cols.map(() => el('td', { style: cell + (i % 2 ? ';background:#f6f6f6' : '') })))))));
  return el('div', {}, Array.from({ length: n }, page));
}

/* ---------- boot ---------- */
setInterval(() => { if (S.token && document.visibilityState === 'visible' && !S.busy && !S.pending && !sheetFor) refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (S.token && document.visibilityState === 'visible') refresh(); });

(async function boot() {
  if (DEMO) {
    try { await loadScript('demo.js'); await window.ClosetDemo.start(); }
    catch (e) { console.error(e); $('#app').textContent = "The demo couldn't start: " + e.message; return; }
    showSignIn(); return;
  }
  S.token = lsGet('tc.token');
  if (S.token && CFG.apiUrl) startApp(); else showSignIn();
})();
})();
