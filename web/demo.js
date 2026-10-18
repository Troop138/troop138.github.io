// Demo mode: runs the real Apps Script code (Code.js) in the browser against an
// in-memory sheet with sample data. Nothing is saved; reload to start over.
// Opened with ?demo=1, or when config.js has apiUrl: "demo".
(function () {
  'use strict';
  const load = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.append(s); });

  window.ClosetDemo = {
    async start() {
      await load('demo/fake-gas.js');
      const env = window.FakeGAS.install(window);
      await load('demo/Code.js');
      const ss = env.ss;
      Object.values(TABS).forEach(t => ss.insertSheet(t.name).appendRow(t.headers));
      const set = ss.getSheetByName('Settings');
      [['App title', 'Troop Closet'], ['Troop name', 'Demo Troop'], ['Barcode prefix', 'TC-'], ['Next barcode number', 1],
        ['Google sign-in client ID', 'demo-client'], ['Session days', 30]].forEach(r => set.appendRow([r[0], r[1], '']));
      ss.getSheetByName('Leaders').appendRow(['demo.admin@example.com', 'Demo Admin', 'Admin', true]);
      ss.getSheetByName('Leaders').appendRow(['demo.leader@example.com', 'Demo Leader', 'Leader', true]);
      ss.getSheetByName('Leaders').appendRow(['demo.treasurer@example.com', 'Demo Treasurer', 'Treasurer', true]);
      const prices = { 'Rank': 1.89, 'Eagle-required merit badge': 3.49, 'Merit badge': 3.49, 'Award & card': 0.99, 'Other': 1 };
      const items = ss.getSheetByName('Items');
      STARTER_ITEMS.forEach(([n, c, rule, re], i) => {
        const cost = n === 'Merit badge sash' ? 24.99 : prices[c];
        items.appendRow(['d' + i, n, c, cost, rule, re, re * 2, i === 1 ? 'TC-0001' : '', true]);
      });
      set.getRange(5, 2).setValue(2);
      const scouts = ss.getSheetByName('Scouts');
      [['Sample Scout A', 'Panthers'], ['Sample Scout B', 'Panthers'], ['Sample Scout C', 'Hawks'], ['Sample Scout D', 'Hawks']]
        .forEach(([n, p], i) => scouts.appendRow(['s' + i, n, p, true]));

      // A little history so the reports have something to show.
      const tok = this.login('demo.admin@example.com');
      const call = (action, args) => this.call({ action, token: tok, args });
      const restock = []; for (let i = 0; i < STARTER_ITEMS.length; i++) restock.push({ itemId: 'd' + i, qty: [3, 2, 4, 6, 1, 0][i % 6] });
      call('restock', { lines: restock.filter(l => l.qty), note: 'Opening count' });
      // d1 Tenderfoot (free), d25 Archery (first free), d54 Totin' Chip (first free), d57 sash (always charged)
      call('give', { scoutId: 's0', lines: [{ itemId: 'd1', qty: 1 }, { itemId: 'd25', qty: 1 }, { itemId: 'd54', qty: 1 }] });
      call('give', { scoutId: 's1', lines: [{ itemId: 'd2', qty: 1 }, { itemId: 'd54', qty: 1 }] });
      call('give', { scoutId: 's0', lines: [{ itemId: 'd54', qty: 1 }] });
      call('give', { scoutId: 's2', lines: [{ itemId: 'd57', qty: 1 }] });
      this.revoke(tok);
    },
    login(email) {
      window.tokeninfo = { aud: 'demo-client', iss: 'accounts.google.com', email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) };
      return this.call({ action: 'login', args: { idToken: 'demo' } }).data.token;
    },
    revoke(tok) { this.call({ action: 'logout', token: tok }); },
    call(body) { return JSON.parse(window.doPost({ postData: { contents: JSON.stringify(body) } }).body); },
  };
})();
