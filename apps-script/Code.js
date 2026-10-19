/**
 * Troop Closet: data API for the advancement-closet web app.
 *
 * This script is bound to the inventory Google Sheet. It is deployed as a web
 * app ("Execute as: Me", "Who has access: Anyone") and answers JSON requests
 * from the page on GitHub Pages. Every request except `login` must carry a
 * session token, and every session belongs to a leader listed on the Leaders
 * tab. The sheet itself stays private to the account that owns it.
 *
 * See README.md for setup.
 */

/* =====================================================================
 * Sheet layout. Code reads columns by header name, so columns can be
 * reordered in the sheet without breaking anything. Don't rename headers.
 * ===================================================================== */

const TABS = {
  settings: { name: 'Settings', headers: ['Setting', 'Value', 'Notes'] },
  leaders:  { name: 'Leaders',  headers: ['Email', 'Name', 'Role', 'Active'] },
  items:    { name: 'Items',    headers: ['ID', 'Name', 'Category', 'Cost', 'Charge rule', 'Reorder at', 'Active', 'Eagle required'] },
  scouts:   { name: 'Scouts',   headers: ['ID', 'First name', 'Last name', 'Active', 'Needs roster update', 'Added by', 'Added on'] },
  log:      { name: 'Log',      headers: ['ID', 'When', 'Item ID', 'Item', 'Change', 'Type', 'Scout ID', 'Scout', 'Note', 'Logged by', 'Unit cost', 'Returns'] },
  charges:  { name: 'Charges',  headers: ['ID', 'When', 'Scout ID', 'Scout', 'Item ID', 'Item', 'Qty', 'Amount', 'Status', 'Reason', 'Log ID', 'Created by', 'Status changed', 'Status changed by'] },
};

const CATEGORIES = ['Rank', 'Patrol patch', 'Merit badge', 'Uniform', 'Position', 'Pin', 'Award & card', 'Eagle', 'Other'];
const CHARGE_RULES = ['Free', 'Always charge', 'First one free'];
const ROLES = ['Admin', 'Leader', 'Treasurer'];
// Pending: owed. Transferred to Treasurer: sent to the treasurer to collect. Waived: not charged (with a reason).
const CHARGE_STATUSES = ['Pending', 'Transferred to Treasurer', 'Waived'];
const LOG_TYPES = ['out', 'in', 'count', 'return'];

const SETTINGS_DEFAULTS = [
  ['App title', 'Troop Closet', 'Shown at the top of the app after sign-in'],
  ['Troop name', '', 'For example: Troop 000. Shown after sign-in only'],
  ['Google sign-in client ID', '', 'From Google Cloud console (see README)'],
  ['Session days', 30, 'How long a phone stays signed in'],
  ['Backups to keep', 12, 'Weekly copies kept in the backup folder'],
  ['Backup folder ID', '', 'Filled in by setup'],
];

const STARTER_ITEMS = [
  ...['Scout', 'Tenderfoot', 'Second Class', 'First Class', 'Star', 'Life', 'Eagle']
    .map(n => [n, 'Rank', 'First one free', n === 'Eagle' ? 1 : 3]),
  ...['Camping', 'Citizenship in Society', 'Citizenship in the Community', 'Citizenship in the Nation',
    'Citizenship in the World', 'Communication', 'Cooking', 'Cycling', 'Emergency Preparedness',
    'Environmental Science', 'Family Life', 'First Aid', 'Hiking', 'Lifesaving', 'Personal Fitness',
    'Personal Management', 'Sustainability', 'Swimming']
    .map(n => [n, 'Merit badge', 'First one free', 2, true]),
  ...['Archery', 'Art', 'Astronomy', 'Canoeing', 'Chemistry', 'Chess', 'Climbing', 'Digital Technology',
    'Engineering', 'Fingerprinting', 'Fire Safety', 'Fishing', 'Geocaching', 'Kayaking', 'Leatherwork',
    'Metalwork', 'Orienteering', 'Photography', 'Pioneering', 'Programming', 'Rifle Shooting', 'Robotics',
    'Search and Rescue', 'Shotgun Shooting', 'Space Exploration', 'Weather', 'Wilderness Survival',
    'Wood Carving', 'Woodwork']
    .map(n => [n, 'Merit badge', 'First one free', 1]),
  ["Totin' Chip", 'Award & card', 'First one free', 5],
  ["Firem'n Chit", 'Award & card', 'First one free', 5],
  ['Merit badge sash', 'Award & card', 'First one free', 2],
];

/* =====================================================================
 * One-time setup. Run from the Apps Script editor: pick `setup`, click Run.
 * Safe to run again; it only adds what is missing.
 * ===================================================================== */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(k => ensureTab_(ss, TABS[k]));

  // Settings defaults.
  const st = sheet_('settings');
  const have = new Set(st.getRange(2, 1, Math.max(1, lastDataRow_(st) - 1), 1).getValues().flat().map(String));
  const missing = SETTINGS_DEFAULTS.filter(r => !have.has(r[0]));
  if (missing.length) st.getRange(lastDataRow_(st) + 1, 1, missing.length, 3).setValues(missing);
  st.setColumnWidth(1, 200); st.setColumnWidth(2, 360); st.setColumnWidth(3, 360);

  // First admin: the account running setup (the troop account).
  const leaders = sheet_('leaders');
  if (lastDataRow_(leaders) < 2) {
    const me = Session.getEffectiveUser().getEmail();
    if (me) appendRows_('leaders', [{ 'Email': me.toLowerCase(), 'Name': 'Troop account', 'Role': 'Admin', 'Active': true }]);
  }

  // Starter item list at zero on hand.
  const items = sheet_('items');
  if (lastDataRow_(items) < 2) {
    const rows = STARTER_ITEMS.map(([n, c, rule, re, eagle]) => [id_(), n, c, 0, rule, re, true, !!eagle]);
    items.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  migratePosted_();
  applyFormatting_(ss);
  buildReportTabs_(ss);
  ensureBackupFolder_();
  ensureTriggers_();

  ['Sheet1'].forEach(n => { const s = ss.getSheetByName(n); if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s); });
  ss.setActiveSheet(ss.getSheetByName('Inventory'));
  return 'Setup complete';
}

function ensureTab_(ss, def) {
  let sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  const width = def.headers.length;
  const cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  if (!cur.filter(Boolean).length) {
    sh.getRange(1, 1, 1, width).setValues([def.headers]);
  } else {
    // Add any header that is missing (columns added in a newer version).
    const add = def.headers.filter(h => cur.indexOf(h) < 0);
    if (add.length) sh.getRange(1, cur.length + 1, 1, add.length).setValues([add]);
  }
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#e3e6da');
  sh.setFrozenRows(1);
  return sh;
}

function applyFormatting_(ss) {
  const listRule = (vals) => SpreadsheetApp.newDataValidation().requireValueInList(vals, true).setAllowInvalid(false).build();

  const it = sheet_('items'), ih = headerMap_(it);
  col_(it, ih, 'Category').setDataValidation(listRule(CATEGORIES));
  col_(it, ih, 'Charge rule').setDataValidation(listRule(CHARGE_RULES));
  col_(it, ih, 'Cost').setNumberFormat('$#,##0.00');
  if (lastDataRow_(it) > 1) it.getRange(2, ih['Eagle required'] + 1, lastDataRow_(it) - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  const sc = sheet_('scouts'), sh = headerMap_(sc);
  fillBlankActive_(sc, sh);
  const nr = sh['Needs roster update'];
  if (nr != null && lastDataRow_(sc) > 1) sc.getRange(2, nr + 1, lastDataRow_(sc) - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  fillBlankActive_(it, ih);

  const le = sheet_('leaders'), lh = headerMap_(le);
  col_(le, lh, 'Role').setDataValidation(listRule(ROLES));
  fillBlankActive_(le, lh);

  const ch = sheet_('charges'), chh = headerMap_(ch);
  col_(ch, chh, 'Status').setDataValidation(listRule(CHARGE_STATUSES));
  col_(ch, chh, 'Amount').setNumberFormat('$#,##0.00');
  col_(ch, chh, 'When').setNumberFormat('m/d/yyyy h:mm am/pm');
  col_(ch, chh, 'Status changed').setNumberFormat('m/d/yyyy h:mm am/pm');


  const lg = sheet_('log'), lgh = headerMap_(lg);
  col_(lg, lgh, 'When').setNumberFormat('ddd m/d/yyyy h:mm am/pm');
  col_(lg, lgh, 'Unit cost').setNumberFormat('$#,##0.00');

  // Warn before editing things the app depends on.
  protect_(lg.getRange('A:Z'), 'Log: change entries through the app (Shelf count, or delete in History) so every change is recorded.');
  [[it, ih], [sc, sh], [ch, chh]].forEach(([s, h]) => protect_(col_(s, h, 'ID'), 'IDs link log entries to items and scouts. Changing one breaks those links.'));
  protect_(col_(ch, chh, 'Amount'), 'Amounts are calculated when the item is given out.');
}

/**
 * Active checkboxes only on rows that hold data (new rows get one when the app
 * adds them). A checkbox on an empty row holds FALSE and makes the row look used.
 * A blank Active on a real row means active.
 */
function fillBlankActive_(sh, h) {
  const col = h['Active'] + 1, last = lastDataRow_(sh), max = sh.getMaxRows();
  if (max > last) { const below = sh.getRange(last + 1, col, max - last, 1); below.clearDataValidations(); below.clearContent(); }
  if (last < 2) return;
  const r = sh.getRange(2, col, last - 1, 1), v = r.getValues();
  let changed = false;
  v.forEach(row => { if (row[0] === '') { row[0] = true; changed = true; } });
  if (changed) r.setValues(v);
  r.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function protect_(range, description) {
  const sh = range.getSheet();
  const existing = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(p => p.getDescription() === description && p.getRange().getA1Notation() === range.getA1Notation());
  if (!existing) range.protect().setDescription(description).setWarningOnly(true);
}

function buildReportTabs_(ss) {
  const items = TABS.items.name, log = TABS.log.name, ch = TABS.charges.name;
  const ih = headerMap_(sheet_('items')), lh = headerMap_(sheet_('log')), chh = headerMap_(sheet_('charges'));
  const L = (h, name) => colLetter_(h[name] + 1);

  // Inventory: on hand is always the sum of the Log, never typed in. (Older versions called this tab Stock.)
  const old = ss.getSheetByName('Stock'); if (old && !ss.getSheetByName('Inventory')) old.setName('Inventory');
  let s = ss.getSheetByName('Inventory') || ss.insertSheet('Inventory', 0);
  s.clear(); s.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  s.getRange('A1:G1').setValues([['Item', 'Category', 'On hand', 'Cost', 'Reorder at', 'Value', 'Status']]).setFontWeight('bold').setBackground('#e3e6da');
  s.setFrozenRows(1);
  const iId = `${items}!${L(ih, 'ID')}2:${L(ih, 'ID')}`;
  s.getRange('A2').setFormula(
    `=ARRAYFORMULA(IFERROR(SORT(FILTER({${items}!${L(ih, 'Name')}2:${L(ih, 'Name')}, ${items}!${L(ih, 'Category')}2:${L(ih, 'Category')}, ` +
    `SUMIF(${log}!${L(lh, 'Item ID')}2:${L(lh, 'Item ID')}, ${iId}, ${log}!${L(lh, 'Change')}2:${L(lh, 'Change')}), ` +
    `${items}!${L(ih, 'Cost')}2:${L(ih, 'Cost')}, ${items}!${L(ih, 'Reorder at')}2:${L(ih, 'Reorder at')}}, ` +
    `${iId}<>"", ${items}!${L(ih, 'Active')}2:${L(ih, 'Active')}<>FALSE), 2, TRUE, 1, TRUE), ""))`);
  s.getRange('F2').setFormula('=ARRAYFORMULA(IF(A2:A="",,C2:C*D2:D))');
  // Reorder at 0 = not kept in stock, so never Low/Out.
  s.getRange('G2').setFormula('=ARRAYFORMULA(IF(A2:A="",,IF(E2:E<=0,IF(C2:C<=0,"Not stocked","OK"),IF(C2:C<=0,"Out",IF(C2:C<=E2:E,"Low","OK")))))');
  s.getRange('D:D').setNumberFormat('$#,##0.00'); s.getRange('F:F').setNumberFormat('$#,##0.00');
  s.setColumnWidth(1, 240); s.setColumnWidth(2, 200);
  s.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Out').setBackground('#f6d6cf').setFontColor('#8e2a18').setRanges([s.getRange('G2:G')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Low').setBackground('#f6e7c4').setFontColor('#7a5410').setRanges([s.getRange('G2:G')]).build(),
  ]);
  s.protect().setDescription('Inventory is calculated from Items and Log. Edit those instead.').setWarningOnly(true);

  // Balances: pending charges by scout, for the treasurer.
  let b = ss.getSheetByName('Balances') || ss.insertSheet('Balances');
  b.clear(); b.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  const range = `${ch}!A2:${colLetter_(TABS.charges.headers.length)}`;
  const q = (c) => `Col${chh[c] + 1}`;
  b.getRange('A1').setFormula(
    `=IFERROR(QUERY({${range}}, "select ${q('Scout')}, count(${q('Amount')}), sum(${q('Amount')}) where ${q('Status')} = 'Pending' group by ${q('Scout')} order by ${q('Scout')} ` +
    `label ${q('Scout')} 'Scout', count(${q('Amount')}) 'Pending charges', sum(${q('Amount')}) 'Amount due'", 0), "No pending charges")`);
  b.getRange('A1:C1').setFontWeight('bold').setBackground('#e3e6da');
  b.getRange('C:C').setNumberFormat('$#,##0.00');
  b.setColumnWidth(1, 240);
  b.protect().setDescription('Balances is calculated from the Charges tab.').setWarningOnly(true);
}

function ensureBackupFolder_() {
  const id = getSetting_('Backup folder ID');
  if (id) { try { DriveApp.getFolderById(id); return; } catch (e) { /* recreate */ } }
  const f = DriveApp.createFolder('Troop Closet backups');
  setSetting_('Backup folder ID', f.getId());
}

function ensureTriggers_() {
  const have = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  if (have.indexOf('weeklyBackup') < 0) {
    ScriptApp.newTrigger('weeklyBackup').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  }
  if (have.indexOf('stampChargeEdit') < 0) {
    ScriptApp.newTrigger('stampChargeEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  }
}

/** Weekly: copy the whole spreadsheet into the backup folder, keep the newest N. */
function weeklyBackup() {
  ensureBackupFolder_();
  const folder = DriveApp.getFolderById(getSetting_('Backup folder ID'));
  const ss = SpreadsheetApp.getActive();
  const stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  DriveApp.getFileById(ss.getId()).makeCopy(`${ss.getName()} backup ${stamp}`, folder);
  const keep = Number(getSetting_('Backups to keep')) || 12;
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(keep).forEach(f => f.setTrashed(true));
}

/** When someone changes a charge's Status by hand in the sheet, record when and who. */
function stampChargeEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== TABS.charges.name || e.range.getRow() < 2) return;
    const h = headerMap_(sh);
    if (e.range.getColumn() !== h['Status'] + 1 || e.range.getNumColumns() !== 1) return;
    const who = (e.user && e.user.getEmail && e.user.getEmail()) || 'edited in sheet';
    for (let r = e.range.getRow(); r < e.range.getRow() + e.range.getNumRows(); r++) {
      sh.getRange(r, h['Status changed'] + 1).setValue(new Date());
      sh.getRange(r, h['Status changed by'] + 1).setValue(who);
    }
  } catch (err) { console.error(err); }
}

/* =====================================================================
 * Web API
 * ===================================================================== */

function doGet() {
  return json_({ ok: true, service: 'troop-closet', note: 'POST JSON requests to this address.' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData && e.postData.contents || '{}'); }
  catch (err) { return json_({ ok: false, code: 'bad_request', error: 'Request was not valid JSON.' }); }
  try {
    const action = String(req.action || '');
    if (action === 'login') return json_({ ok: true, data: login_(req.idToken || (req.args && req.args.idToken)) });
    const me = sessionUser_(req.token);
    const fn = ACTIONS[action];
    if (!fn) throw apiError_('bad_request', 'Unknown action.');
    return json_({ ok: true, data: fn(me, req.args || {}) });
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, error: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'server_error', error: 'Something went wrong on the server. Try again.' });
  }
}

const ACTIONS = {
  logout: (me, a, token) => { revokeSessions_(me.email, me.sessionKey); return true; },
  getData: (me) => getData_(me),
  give: (me, a) => withLock_(() => give_(me, a)),
  restock: (me, a) => withLock_(() => restock_(me, a)),
  count: (me, a) => withLock_(() => count_(me, a)),
  undo: (me, a) => withLock_(() => undo_(me, a)),
  addScout: (me, a) => withLock_(() => addScout_(me, a)),
  updateScout: (me, a) => withLock_(() => updateScout_(me, a)),
  addItem: (me, a) => { need_(me, ['Admin']); return withLock_(() => addItem_(me, a)); },
  updateItem: (me, a) => withLock_(() => updateItem_(me, a)),
  checkIn: (me, a) => withLock_(() => checkIn_(me, a)),
  setChargeStatus: (me, a) => { need_(me, ['Admin', 'Treasurer']); return withLock_(() => setChargeStatus_(me, a)); },
  saveLeader: (me, a) => { need_(me, ['Admin']); return withLock_(() => saveLeader_(me, a)); },
  signOutEverywhere: (me, a) => { need_(me, ['Admin']); revokeSessions_(String(a.email || '').toLowerCase()); return true; },
};

/* ---------- auth ---------- */

function login_(idToken) {
  if (!idToken) throw apiError_('unauthorized', 'Sign in with Google to continue.');
  const clientId = String(getSetting_('Google sign-in client ID') || '').trim();
  if (!clientId) throw apiError_('not_configured', 'Google sign-in is not set up yet. Add the client ID on the Settings tab.');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw apiError_('unauthorized', 'Google sign-in could not be verified. Try again.');
  const t = JSON.parse(res.getContentText());
  const okIss = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (t.aud !== clientId || !okIss || String(t.email_verified) !== 'true' || Number(t.exp) * 1000 < Date.now()) {
    throw apiError_('unauthorized', 'Google sign-in could not be verified. Try again.');
  }
  const email = String(t.email).toLowerCase();
  const leader = findLeader_(email);
  if (!leader) throw apiError_('not_a_leader', `${email} isn't on the leader list. Ask the closet admin to add you.`);

  const token = Utilities.getUuid() + Utilities.getUuid();
  const days = Math.max(1, Number(getSetting_('Session days')) || 30);
  PropertiesService.getScriptProperties().setProperty('s_' + sha256_(token), JSON.stringify({ email, exp: Date.now() + days * 864e5 }));
  pruneSessions_();
  return { token, me: publicMe_(leader), expiresInDays: days };
}

function sessionUser_(token) {
  if (!token) throw apiError_('unauthorized', 'Sign in to continue.');
  const key = 's_' + sha256_(String(token));
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) throw apiError_('unauthorized', 'Your sign-in has expired. Sign in again.');
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) { PropertiesService.getScriptProperties().deleteProperty(key); throw apiError_('unauthorized', 'Your sign-in has expired. Sign in again.'); }
  const leader = findLeader_(s.email);
  if (!leader) { PropertiesService.getScriptProperties().deleteProperty(key); throw apiError_('unauthorized', 'Your access was removed. Ask the closet admin if this is a mistake.'); }
  leader.sessionKey = key;
  return leader;
}

function findLeader_(email) {
  email = String(email || '').toLowerCase().trim();
  const row = readTable_('leaders').find(r => String(r['Email']).toLowerCase().trim() === email);
  if (!row || row['Active'] === false || String(row['Active']).toUpperCase() === 'FALSE') return null;
  const role = ROLES.indexOf(row['Role']) >= 0 ? row['Role'] : 'Leader';
  return { email, name: String(row['Name'] || email.split('@')[0]), role };
}

function publicMe_(l) { return { email: l.email, name: l.name, role: l.role }; }

function revokeSessions_(email, onlyKey) {
  const props = PropertiesService.getScriptProperties();
  if (onlyKey) { props.deleteProperty(onlyKey); return; }
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('s_') !== 0) return;
    try { if (JSON.parse(all[k]).email === email) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function pruneSessions_() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(k => { if (k.indexOf('s_') === 0) { try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } } });
}

function need_(me, roles) {
  if (roles.indexOf(me.role) < 0) throw apiError_('forbidden', `This needs the ${roles.join(' or ')} role.`);
}

/* ---------- reads ---------- */

function getData_(me) {
  const items = readTable_('items').filter(r => r['ID']).map(itemOut_);
  const scouts = readTable_('scouts').filter(r => r['ID']).map(r => ({
    id: String(r['ID']), name: scoutName_(r), first: String(r['First name'] || ''), last: String(r['Last name'] || ''), active: r['Active'] !== false,
    needsUpdate: r['Needs roster update'] === true || String(r['Needs roster update']).toUpperCase() === 'TRUE',
    addedBy: String(r['Added by'] || ''), addedAt: time_(r['Added on']),
  }));
  const log = readTable_('log').filter(r => r['ID']).map(r => ({
    id: String(r['ID']), at: time_(r['When']), itemId: String(r['Item ID']), itemName: String(r['Item']),
    delta: Number(r['Change']) || 0, kind: String(r['Type']), scoutId: String(r['Scout ID'] || ''), scoutName: String(r['Scout'] || ''),
    note: String(r['Note'] || ''), by: String(r['Logged by'] || ''), unitCost: Number(r['Unit cost']) || 0, returns: String(r['Returns'] || ''),
  }));
  const charges = readTable_('charges').filter(r => r['ID']).map(chargeOut_);
  const out = {
    me: publicMe_(me),
    settings: {
      appTitle: String(getSetting_('App title') || 'Troop Closet'),
      troopName: String(getSetting_('Troop name') || ''),
    },
    items, scouts, log, charges,
    sheetUrl: me.role === 'Admin' ? SpreadsheetApp.getActive().getUrl() : '',
  };
  if (me.role === 'Admin') {
    out.leaders = readTable_('leaders').filter(r => r['Email']).map(r => ({
      email: String(r['Email']).toLowerCase(), name: String(r['Name'] || ''), role: String(r['Role'] || 'Leader'), active: r['Active'] !== false,
    }));
  }
  return out;
}

function itemOut_(r) {
  return {
    id: String(r['ID']), name: String(r['Name']),
    // Older sheets had an "Eagle-required merit badge" category; it is now Merit badge + the Eagle required box.
    cat: ({ 'Eagle-required merit badge': 'Merit badge', 'Uniform & patches': 'Uniform', 'Position patch': 'Position', 'Rank pin': 'Pin' })[r['Category']] || String(r['Category'] || 'Other'),
    eagleReq: r['Eagle required'] === true || String(r['Eagle required']).toUpperCase() === 'TRUE' || r['Category'] === 'Eagle-required merit badge',
    cost: Number(r['Cost']) || 0, rule: CHARGE_RULES.indexOf(r['Charge rule']) >= 0 ? r['Charge rule'] : 'Free',
    reorder: Number(r['Reorder at']) || 0,
    active: r['Active'] !== false,
  };
}

function chargeOut_(r) {
  return {
    id: String(r['ID']), at: time_(r['When']), scoutId: String(r['Scout ID']), scoutName: String(r['Scout']),
    itemId: String(r['Item ID']), itemName: String(r['Item']), qty: Number(r['Qty']) || 1,
    amount: Number(r['Amount']) || 0, status: r['Status'] === 'Posted' ? 'Transferred to Treasurer' : CHARGE_STATUSES.indexOf(r['Status']) >= 0 ? r['Status'] : 'Pending',
    reason: String(r['Reason'] || ''), logId: String(r['Log ID'] || ''), by: String(r['Created by'] || ''),
    changedAt: time_(r['Status changed']), changedBy: String(r['Status changed by'] || ''),
  };
}

/* ---------- writes ---------- */

/**
 * Give items to a scout.
 * args: { scoutId, lines: [{ itemId, qty, waiveReason? }] }
 * Charges follow each item's charge rule. "First one free" checks the scout's history.
 */
function give_(me, a) {
  const scout = scoutById_(a.scoutId);
  if (!scout || scout['Active'] === false) throw apiError_('bad_request', 'That scout is not on the active list.');
  const lines = cleanLines_(a.lines);
  if (me.role !== 'Admin' && lines.some(l => String(l.waiveReason || '').trim())) throw apiError_('forbidden', 'Only the closet admin can give an item without charging.');
  const ctx = giveContext_();
  lines.forEach(l => giveOne_(me, ctx, scout, l.itemId, l.qty, '', l.waiveReason));
  const logRows = ctx.logRows, chargeRows = ctx.chargeRows;
  appendRows_('log', logRows);
  if (chargeRows.length) appendRows_('charges', chargeRows);
  return { logIds: logRows.map(r => r['ID']), chargeIds: chargeRows.map(r => r['ID']), charged: round2_(chargeRows.filter(r => r['Status'] === 'Pending').reduce((s, r) => s + r['Amount'], 0)) };
}

/** Shared state for one batch of give-outs, so "first one free" sees earlier lines in the same batch. */
function giveContext_() {
  return { items: itemsById_(), log: readTable_('log'), now: new Date(), logRows: [], chargeRows: [] };
}

/** Queue one give-out (and its charge, if any) in ctx. Caller appends ctx.logRows / ctx.chargeRows. */
function giveOne_(me, ctx, scout, itemId, qty, note, waiveReason) {
  const it = ctx.items[itemId];
  if (!it) throw apiError_('bad_request', 'One of those items was removed. Refresh and try again.');
  const cost = Number(it['Cost']) || 0, rule = it['Charge rule'], now = ctx.now;
  const logId = id_();
  const row = { 'ID': logId, 'When': now, 'Item ID': itemId, 'Item': it['Name'], 'Change': -qty, 'Type': 'out',
    'Scout ID': scout['ID'], 'Scout': scoutName_(scout), 'Note': String(note || '').slice(0, 200), 'Logged by': me.email, 'Unit cost': cost };
  let charged = 0;
  if (rule === 'Always charge') charged = qty;
  else if (rule === 'First one free') {
    // Items checked back in don't count as the scout's free one.
    const prior = ctx.log.filter(r => String(r['Scout ID']) === String(scout['ID']) && String(r['Item ID']) === itemId && (r['Type'] === 'out' || r['Type'] === 'return'))
      .reduce((s, r) => s - (Number(r['Change']) || 0), 0);
    charged = prior > 0 ? qty : qty - 1;
  }
  ctx.log.push(row); ctx.logRows.push(row);
  if (charged > 0 && cost > 0) {
    const waived = String(waiveReason || '').trim();
    ctx.chargeRows.push({ 'ID': id_(), 'When': now, 'Scout ID': scout['ID'], 'Scout': scoutName_(scout), 'Item ID': itemId, 'Item': it['Name'],
      'Qty': charged, 'Amount': round2_(charged * cost), 'Status': waived ? 'Waived' : 'Pending', 'Reason': waived.slice(0, 200),
      'Log ID': logId, 'Created by': me.email, 'Status changed': waived ? now : '', 'Status changed by': waived ? me.email : '' });
  }
  return logId;
}

/* ---------- check back in ---------- */

/**
 * Check given-out items back in to stock (e.g. envelopes nobody picked up). Any leader.
 * args: { logIds: [give-out log IDs], note }
 * Logs a 'return' against the same scout and waives any pending charge for that give-out.
 */
function checkIn_(me, a) {
  const ids = new Set((a.logIds || []).map(String));
  if (!ids.size) return { returned: 0 };
  const log = readTable_('log');
  const already = new Set(log.filter(r => r['Type'] === 'return' && r['Returns']).map(r => String(r['Returns'])));
  const outs = log.filter(r => ids.has(String(r['ID'])) && r['Type'] === 'out' && r['Scout ID'] && !already.has(String(r['ID'])));
  const done = new Set(outs.map(o => String(o['ID'])));
  const charges = readTable_('charges').filter(c => done.has(String(c['Log ID'])));
  if (charges.some(c => c['Status'] === 'Transferred to Treasurer')) throw apiError_('conflict', 'A charge for one of these was already transferred to the treasurer. Set it back to Pending first.');
  const now = new Date(), note = String(a.note || '').trim().slice(0, 200);
  const rows = outs.map(o => ({ 'ID': id_(), 'When': now, 'Item ID': o['Item ID'], 'Item': o['Item'], 'Change': -(Number(o['Change']) || 0), 'Type': 'return',
    'Scout ID': o['Scout ID'], 'Scout': o['Scout'], 'Note': note || 'Checked back in', 'Logged by': me.email,
    'Unit cost': o['Unit cost'], 'Returns': o['ID'] }));
  appendRows_('log', rows);
  charges.filter(c => c['Status'] === 'Pending')
    .forEach(c => updateRow_('charges', c._row, { 'Status': 'Waived', 'Reason': 'Checked back in', 'Status changed': now, 'Status changed by': me.email }));
  return { returned: rows.length, logIds: rows.map(r => r['ID']) };
}

function restock_(me, a) {
  const lines = cleanLines_(a.lines), items = itemsById_(), now = new Date(), note = String(a.note || '').slice(0, 200);
  const rows = lines.map(l => {
    const it = items[l.itemId];
    if (!it) throw apiError_('bad_request', 'One of those items was removed. Refresh and try again.');
    return { 'ID': id_(), 'When': now, 'Item ID': l.itemId, 'Item': it['Name'], 'Change': l.qty, 'Type': 'in',
      'Scout ID': '', 'Scout': '', 'Note': note, 'Logged by': me.email, 'Unit cost': Number(it['Cost']) || 0 };
  });
  appendRows_('log', rows);
  return { logIds: rows.map(r => r['ID']) };
}

/** Shelf count: logs the difference between what's counted and what the app thinks is there. */
function count_(me, a) {
  const it = itemsById_()[String(a.itemId)];
  if (!it) throw apiError_('bad_request', 'That item no longer exists.');
  const target = Math.trunc(Number(a.target));
  if (!(target >= 0)) throw apiError_('bad_request', 'Enter the number on the shelf.');
  const onHand = readTable_('log').filter(r => String(r['Item ID']) === String(a.itemId)).reduce((s, r) => s + (Number(r['Change']) || 0), 0);
  const d = target - onHand;
  if (!d) return { logIds: [] };
  const row = { 'ID': id_(), 'When': new Date(), 'Item ID': String(a.itemId), 'Item': it['Name'], 'Change': d, 'Type': 'count',
    'Scout ID': '', 'Scout': '', 'Note': String(a.note || 'Shelf count').slice(0, 200), 'Logged by': me.email, 'Unit cost': Number(it['Cost']) || 0 };
  appendRows_('log', [row]);
  return { logIds: [row['ID']] };
}

/** Remove log entries (and their charges). Leaders: their own entries from the last 24 hours. Admin: any. */
function undo_(me, a) {
  const ids = new Set((a.logIds || []).map(String));
  if (!ids.size) return true;
  const log = readTable_('log').filter(r => ids.has(String(r['ID'])));
  log.forEach(r => {
    const own = String(r['Logged by']).toLowerCase() === me.email && Date.now() - time_(r['When']) < 864e5;
    if (me.role !== 'Admin' && !own) throw apiError_('forbidden', 'Only the closet admin can remove that entry. You can remove your own entries for 24 hours.');
  });
  const charges = readTable_('charges').filter(c => ids.has(String(c['Log ID'])));
  if (charges.some(c => c['Status'] === 'Transferred to Treasurer')) throw apiError_('conflict', 'The charge for this entry was already transferred to the treasurer. Set it back to Pending first.');
  // Undoing a check-in restores the charge it waived.
  const rets = log.filter(r => r['Type'] === 'return' && r['Returns']);
  if (rets.length) {
    const outIds = new Set(rets.map(r => String(r['Returns'])));
    readTable_('charges').filter(c => outIds.has(String(c['Log ID'])) && c['Status'] === 'Waived' && c['Reason'] === 'Checked back in')
      .forEach(c => updateRow_('charges', c._row, { 'Status': 'Pending', 'Reason': '', 'Status changed': '', 'Status changed by': '' }));
  }
  deleteRows_('charges', charges.map(c => c._row));
  deleteRows_('log', log.map(r => r._row));
  return true;
}

/**
 * Any leader can add a scout with first and last name. Scouts
 * added by someone other than an admin are flagged "Needs roster update" and
 * the admins get an email, so the rest of the scout's details get updated.
 */
function addScout_(me, a) {
  const first = String(a.first || '').trim().slice(0, 40), last = String(a.last || '').trim().slice(0, 40);
  if (!first || !last) throw apiError_('bad_request', "Enter the scout's first and last name.");
  const name = `${first} ${last}`;
  const dup = readTable_('scouts').find(r => scoutName_(r).toLowerCase() === name.toLowerCase());
  if (dup) throw apiError_('conflict', dup['Active'] === false
    ? `${name} is already on the roster but archived. Ask the closet admin to restore them.`
    : `${name} is already on the roster.`);
  const flag = me.role !== 'Admin';
  const row = { 'ID': id_(), 'First name': first, 'Last name': last,
    'Active': true, 'Needs roster update': flag, 'Added by': me.email, 'Added on': new Date() };
  appendRows_('scouts', [row]);
  if (flag) notifyAdmins_(`New scout added: ${name}`,
    `${me.name} (${me.email}) added a scout to the closet:\n\n` +
    `  ${name}\n\n` +
    `Update their details on the troop roster, then mark them updated in the app: More > Scouts.\n`);
  return { id: row['ID'], needsUpdate: flag };
}

/** Email every active admin. Never blocks the change that triggered it. */
function notifyAdmins_(subject, body) {
  try {
    const to = readTable_('leaders').filter(r => r['Role'] === 'Admin' && r['Active'] !== false && r['Email']).map(r => String(r['Email']).trim());
    if (!to.length) return;
    const title = String(getSetting_('App title') || 'Troop Closet');
    MailApp.sendEmail({ to: to.join(','), subject: `${title}: ${subject}`, body, name: title });
  } catch (err) { console.error('notifyAdmins_ failed', err); }
}

function updateScout_(me, a) {
  const s = scoutById_(a.id);
  if (!s) throw apiError_('bad_request', 'That scout no longer exists.');
  need_(me, ['Admin']); // leaders add scouts; only admins change them
  const patch = {};
  if ('first' in a || 'last' in a) {
    const first = String(a.first || '').trim().slice(0, 40), last = String(a.last || '').trim().slice(0, 40);
    if (!first || !last) throw apiError_('bad_request', "Enter the scout's first and last name.");
    Object.assign(patch, { 'First name': first, 'Last name': last });
  }
  if ('active' in a) patch['Active'] = !!a.active;
  if ('updated' in a) patch['Needs roster update'] = !a.updated;
  updateRow_('scouts', s._row, patch);
  return true;
}

function addItem_(me, a) {
  const name = String(a.name || '').trim();
  if (!name) throw apiError_('bad_request', 'Give the item a name.');
  if (readTable_('items').some(r => r['Active'] !== false && String(r['Name']).toLowerCase() === name.toLowerCase())) {
    throw apiError_('conflict', `${name} is already in the closet.`);
  }
  const row = Object.assign({ 'ID': id_(), 'Name': titleCase_(name).slice(0, 100), 'Active': true }, itemPatch_(a, true));
  appendRows_('items', [row]);
  const start = Math.trunc(Number(a.startQty) || 0);
  if (start > 0) appendRows_('log', [{ 'ID': id_(), 'When': new Date(), 'Item ID': row['ID'], 'Item': row['Name'], 'Change': start, 'Type': 'count',
    'Scout ID': '', 'Scout': '', 'Note': 'Starting count', 'Logged by': me.email, 'Unit cost': row['Cost'] || 0 }]);
  return { id: row['ID'] };
}

function updateItem_(me, a) {
  const it = itemsById_()[String(a.id)];
  if (!it) throw apiError_('bad_request', 'That item no longer exists.');
  need_(me, ['Admin']); // only admins change items, including reorder levels
  const patch = itemPatch_(a, false);
  if ('name' in a) { const n = String(a.name).trim(); if (!n) throw apiError_('bad_request', 'Give the item a name.'); patch['Name'] = titleCase_(n).slice(0, 100); }
  if ('active' in a) patch['Active'] = !!a.active;
  updateRow_('items', it._row, patch);
  return true;
}

function itemPatch_(a, withDefaults) {
  const p = {};
  if ('cat' in a || withDefaults) p['Category'] = CATEGORIES.indexOf(a.cat) >= 0 ? a.cat : 'Other';
  if ('cost' in a || withDefaults) p['Cost'] = Math.max(0, round2_(Number(a.cost) || 0));
  if ('rule' in a || withDefaults) p['Charge rule'] = CHARGE_RULES.indexOf(a.rule) >= 0 ? a.rule : 'Free';
  if ('reorder' in a || withDefaults) p['Reorder at'] = Math.max(0, Math.trunc(Number(a.reorder) || 0));
  if ('eagleReq' in a || withDefaults) p['Eagle required'] = !!a.eagleReq;
  return p;
}

/** Older versions called this "Posted". */
function migratePosted_() {
  readTable_('charges').filter(c => c['Status'] === 'Posted').forEach(c => updateRow_('charges', c._row, { 'Status': 'Transferred to Treasurer' }));
}

function setChargeStatus_(me, a) {
  const status = a.status === 'Posted' ? 'Transferred to Treasurer' : String(a.status);
  if (CHARGE_STATUSES.indexOf(status) < 0) throw apiError_('bad_request', 'Unknown charge status.');
  const ids = new Set((a.ids || []).map(String));
  const rows = readTable_('charges').filter(c => ids.has(String(c['ID'])));
  const now = new Date();
  rows.forEach(c => {
    const patch = { 'Status': status, 'Status changed': now, 'Status changed by': me.email };
    if (status === 'Waived') patch['Reason'] = String(a.reason || c['Reason'] || '').slice(0, 200);
    updateRow_('charges', c._row, patch);
  });
  return { updated: rows.length };
}

function saveLeader_(me, a) {
  const email = String(a.email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw apiError_('bad_request', 'Enter a valid email address.');
  const role = ROLES.indexOf(a.role) >= 0 ? a.role : 'Leader';
  const active = a.active !== false;
  const rows = readTable_('leaders');
  const row = rows.find(r => String(r['Email']).toLowerCase().trim() === email);
  if (email === me.email && (role !== 'Admin' || !active)) {
    const otherAdmins = rows.filter(r => r['Role'] === 'Admin' && r['Active'] !== false && String(r['Email']).toLowerCase() !== email);
    if (!otherAdmins.length) throw apiError_('conflict', "You're the only admin. Make someone else an admin first.");
  }
  const vals = { 'Email': email, 'Name': String(a.name || '').trim().slice(0, 80), 'Role': role, 'Active': active };
  if (row) updateRow_('leaders', row._row, vals); else appendRows_('leaders', [vals]);
  if (!active || (row && row['Role'] !== role)) revokeSessions_(email);
  return true;
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function sheet_(k) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TABS[k].name);
  if (!sh) throw apiError_('not_configured', `The ${TABS[k].name} tab is missing. Run setup again.`);
  return sh;
}

function headerMap_(sh) {
  const hs = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  const m = {}; hs.forEach((h, i) => { if (h !== '') m[String(h).trim()] = i; });
  return m;
}

/** The column that identifies a row: ID, Email (Leaders) or Setting. */
function keyCol_(h) {
  const k = ['ID', 'Email', 'Setting'].find(n => h[n] != null);
  return k ? h[k] : 0;
}

/**
 * Last row that has a value in the key column. Checkbox columns make empty
 * rows look non-empty (they hold FALSE), so getLastRow() can't be trusted.
 */
function lastDataRow_(sh) {
  const n = sh.getLastRow();
  if (n < 2) return n;
  const c = keyCol_(headerMap_(sh));
  const v = sh.getRange(1, c + 1, n, 1).getValues();
  for (let i = n - 1; i >= 1; i--) if (v[i][0] !== '' && v[i][0] !== null) return i + 1;
  return 1;
}

function col_(sh, h, name) {
  if (h[name] == null) throw new Error(`Column "${name}" is missing on ${sh.getName()}.`);
  return sh.getRange(2, h[name] + 1, sh.getMaxRows() - 1, 1);
}

/** Read a tab into objects keyed by header. Each object has `_row` (sheet row number). */
function readTable_(k) {
  const sh = sheet_(k), h = headerMap_(sh), n = lastDataRow_(sh) - 1;
  if (n < 1) return [];
  const vals = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
  return vals.map((v, i) => { const o = { _row: i + 2 }; Object.keys(h).forEach(name => { o[name] = v[h[name]]; }); return o; });
}

function appendRows_(k, objs) {
  if (!objs.length) return;
  const sh = sheet_(k), h = headerMap_(sh), width = sh.getLastColumn();
  const rows = objs.map(o => { const r = new Array(width).fill(''); Object.keys(o).forEach(name => { if (h[name] != null) r[h[name]] = o[name]; }); return r; });
  const at = lastDataRow_(sh) + 1;
  if (at + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), at + rows.length - 1 - sh.getMaxRows() + 100);
  sh.getRange(at, 1, rows.length, width).setValues(rows);
  if (typeof SpreadsheetApp.newDataValidation === 'function') {
    ['Active', 'Needs roster update', 'Eagle required'].forEach(c => { if (h[c] != null) sh.getRange(at, h[c] + 1, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build()); });
  }
}

function updateRow_(k, row, patch) {
  const sh = sheet_(k), h = headerMap_(sh);
  Object.keys(patch).forEach(name => { if (h[name] != null) sh.getRange(row, h[name] + 1).setValue(patch[name]); });
}

function deleteRows_(k, rowNums) {
  const sh = sheet_(k);
  rowNums.slice().sort((x, y) => y - x).forEach(r => sh.deleteRow(r));
}

function itemsById_() { const m = {}; readTable_('items').forEach(r => { if (r['ID']) m[String(r['ID'])] = r; }); return m; }
/** Scouts have First name and Last name columns (older sheets had a single Name). */
/** Item names: capitalize each word ("merit badge sash" -> "Merit Badge Sash"); small words stay lowercase mid-name ("Citizenship in the World"). */
function titleCase_(s) {
  const small = ['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'];
  return String(s).trim().replace(/\s+/g, ' ').split(' ').map((w, i) => {
    const core = w.replace(/^\(/, '');
    if (i > 0 && small.indexOf(core) >= 0) return w;
    return w.replace(/[A-Za-z]/, c => c.toUpperCase());
  }).join(' ');
}
function scoutName_(r) { return `${String(r['First name'] || '').trim()} ${String(r['Last name'] || '').trim()}`.trim() || String(r['Name'] || '').trim(); }
function scoutById_(id) { return readTable_('scouts').find(r => String(r['ID']) === String(id)); }

function cleanLines_(lines) {
  const merged = {};
  (lines || []).forEach(l => {
    const q = Math.trunc(Number(l && l.qty));
    if (!l || !l.itemId || !(q > 0) || q > 500) return;
    const k = String(l.itemId);
    merged[k] = merged[k] || { itemId: k, qty: 0, waiveReason: '' };
    merged[k].qty += q;
    if (l.waiveReason) merged[k].waiveReason = String(l.waiveReason);
  });
  const out = Object.keys(merged).map(k => merged[k]);
  if (!out.length) throw apiError_('bad_request', 'Add at least one item.');
  return out;
}

function getSetting_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TABS.settings.name);
  if (!sh || lastDataRow_(sh) < 2) return '';
  const v = sh.getRange(2, 1, lastDataRow_(sh) - 1, 2).getValues().find(r => String(r[0]).trim() === name);
  return v ? v[1] : '';
}

function setSetting_(name, value) {
  const sh = sheet_('settings');
  const last = lastDataRow_(sh);
  const vals = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  const i = vals.findIndex(r => String(r[0]).trim() === name);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(value); else sh.getRange(last + 1, 1, 1, 3).setValues([[name, value, '']]);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_('busy', 'The closet is busy. Try again in a moment.');
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

function id_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function round2_(n) { return Math.round(n * 100) / 100; }
function time_(v) { return v instanceof Date ? v.getTime() : (v ? new Date(v).getTime() || 0 : 0); }
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function sha256_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join(''); }
function apiError_(code, message) { const e = new Error(message); e.code = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
