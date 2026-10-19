# Troop Closet

A phone-first inventory app for a Scouts BSA troop's advancement closet: rank patches, merit badges, cards and awards. Leaders sign in with Google, give items to scouts or restock in a few taps, and charges are tracked until they're transferred to the treasurer. A printable paper log covers anyone who'd rather write it down.

**Try it with sample data:** open the site with `?demo=1` at the end of the address. Nothing is saved.

## How it fits together

| Part | Where it lives | What it does |
|---|---|---|
| **Data** | A private Google Sheet owned by the troop's Google account | Items, scouts, every give-out and restock, charges, leaders |
| **Data API** | Apps Script bound to that sheet (`apps-script/`) | Checks each person's Google sign-in against the Leaders tab, then reads and writes the sheet |
| **Web page** | GitHub Pages, from `web/` | Screens only. No data is stored in this repo or on the site. |

Everything is JavaScript. There's no build step: the files in `web/` are exactly what GitHub Pages serves.

```
web/            the site (index.html, app.js, app.css, config.js, vendor libraries)
apps-script/    Code.js + appsscript.json, pushed to Google with clasp
test/           backend tests (run with Node) and stand-ins for Google's services
.github/        workflow that runs the tests and publishes web/ to GitHub Pages
HANDOFF.md      how to hand the closet to the next person
```

## What leaders can do

- **Give out:** pick a scout, tap + on each item, confirm. Charges follow each item's charge rule. A leader can mark a charge "No charge" with a reason.
- **Restock:** tap + on what you're putting away, with an optional note like "Scout Shop order".
- **Paper log:** More → Print paper log. Leaders who don't use the app write one item per line with a quantity (RETURN before the item name for anything put back on the shelf); a photo of the page gets entered later.
- **Reports:** current inventory with shelf value, reorder list, activity by date range, scout history, charges, and shelf-count fixes. Each downloads as CSV or prints.

Roles, set on the **Leaders** tab:

| Role | Can |
|---|---|
| Leader | Give out, restock, shelf counts, add scouts (first name, last name, patrol), reports. Undo their own entries for 24 hours. |
| Treasurer | Everything a leader can, plus mark charges Transferred to Treasurer or Waived. |
| Admin | Everything, plus items, costs, charge rules, leaders, and removing any entry. |

When a leader adds a scout, the scout is flagged **Needs roster update** and every admin gets an email. Admins see a notice in the app (More → Scouts), update the scout's details on the troop roster, then tap **Mark updated**. Only admins can edit or archive scouts.

Charge rules, set per item:

| Rule | At give-out |
|---|---|
| Free | Never charged |
| Always charge | Charged every time |
| First one free | Free the first time that scout gets it, charged after that |

Charges start **Pending** (money the scout owes). When you send them to the treasurer, mark them **Transferred to Treasurer** (Reports → Charges), or **Waived** with a reason. A transfer marked by mistake can be set back to Pending.

## Setup

Do these signed in as the **troop Google account** unless a step says otherwise. Whoever owns the sheet, the script and the sign-in setup owns the app, so use the troop account, not a personal one.

### 1. Create the sheet and script

1. Go to [sheets.new](https://sheets.new) and name the sheet **Troop Closet**.
2. In the sheet, open **Extensions → Apps Script**. Name the project **Troop Closet**.
3. In the Apps Script editor, open **Project Settings** (gear icon). Tick **Show "appsscript.json" manifest file in editor**, and copy the **Script ID**.

### 2. Push the code with clasp

On your computer (any account can do this part, but `clasp login` must be the troop account):

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Run `npm install -g @google/clasp`.
3. Turn on the Apps Script API for the troop account at [script.google.com/home/usersettings](https://script.google.com/home/usersettings).
4. Run `clasp login` and sign in as the **troop account**.
5. Clone this repo, then in its folder:
   ```
   cp .clasp.json.example .clasp.json
   ```
   Paste the Script ID into `.clasp.json`.
6. Run `clasp push`. Answer **yes** if it asks to overwrite the manifest.

> **One rule from now on:** don't edit code in the Apps Script editor in the browser. The next `clasp push` silently overwrites anything changed there. Edit the files in this repo, commit, then `clasp push`.

The time zone is set in `apps-script/appsscript.json` (`America/Chicago`). Change it if the troop is elsewhere, then push again.

### 3. Run setup

1. In the Apps Script editor, pick **setup** in the function menu and click **Run**.
2. Google asks for permission. Because this is your own script and not a published app, it shows "Google hasn't verified this app". Click **Advanced → Go to Troop Closet (unsafe)**, then **Allow**.

Setup creates the tabs, adds the troop account as the first Admin, loads a starter list of ranks, merit badges and cards at zero on hand, creates a **Troop Closet backups** folder in Drive, and schedules a weekly backup copy (Sundays around 2 AM). It's safe to run again; it only adds what's missing.

### 4. Set up Google sign-in

1. Open the [Google Cloud console](https://console.cloud.google.com) and create a project named **Troop Closet**.
2. Go to **APIs & Services → OAuth consent screen** (may be called **Google Auth Platform**). Fill in the app name (Troop Closet) and the troop account as the support email. Choose **External**. The app only asks for name and email, so it doesn't need Google's review. **Publish** it (or move it to Production) so anyone you add to the Leaders tab can sign in.
3. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**). Choose **Web application**. Under **Authorized JavaScript origins**, add your GitHub Pages origin, for example `https://YOUR-ORG.github.io` (no path, no trailing slash).
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
5. Paste it in two places:
   - The sheet's **Settings** tab, next to **Google sign-in client ID**.
   - `web/config.js`, as `googleClientId`.

### 5. Deploy the data API

1. In the Apps Script editor, click **Deploy → New deployment**. Choose type **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. "Anyone" is needed so the page can reach it. Every request still needs a valid sign-in from someone on the Leaders tab.
3. Click **Deploy** and copy the **Web app URL**.
4. Paste it into `web/config.js` as `apiUrl`.

When you change `Code.js` later, run `clasp push`, then in the editor go to **Deploy → Manage deployments → (pencil) → Version: New version → Deploy**. That keeps the same URL, so the page doesn't need to change.

From the command line instead: `clasp push`, then `clasp redeploy <deploymentId> --description "what changed"`. The deployment ID is the long part of the Web app URL between `/s/` and `/exec`, and `clasp deployments` lists it. Don't use `clasp deploy` for updates: that makes a new deployment with a new URL.

### 6. Publish the site

1. In this repo on GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Commit the updated `web/config.js` and push to `main`. The workflow runs the tests and publishes `web/`.
3. The site appears at `https://YOUR-ORG.github.io/<repo-name>/`. If the repo is named `YOUR-ORG.github.io`, it's served at `https://YOUR-ORG.github.io/` instead. Check **Settings → Pages → Enforce HTTPS** is on.

### 7. Add leaders and set up items

1. Open the site, sign in as the troop account, and go to **More → Leaders & access**. Add your own Gmail as **Admin**, plus the treasurer and other leaders. You can also edit the **Leaders** tab directly.
2. On the **Inventory** tab, open each item to set its cost and charge rule, or edit the **Items** tab.
3. Use **Restock** (or **Set count** on an item) to enter what's on the shelf.
4. Use **More → Share the app** for a QR code leaders can scan, then have them add it to their home screen.

## Check back in

- Every give-out on a scout's page has a **Check back in** button. It puts the item back in stock and waives any pending charge.
- **Reports → Check back in** lists everything given out in the last year, grouped by day, patrol and scout. Tick the items nobody picked up and check them back in. Leaders and admins can do this; treasurers can't.
- Court of honor give-outs are entered in bulk straight into the Log (and Charges for items that cost money), outside the app.

## Editing the sheet by hand

The app reads columns by header name, so you can reorder columns, but don't rename headers.

| Tab | Safe to edit | Leave alone |
|---|---|---|
| Items | Name, Category, Cost, Charge rule, Reorder at, Stock to, Active | ID |
| Scouts | Name, Patrol, Active | ID |
| Leaders | Everything (this is how you manage access) | |
| Charges | Status (dropdown). The date and who changed it are filled in automatically. | ID, Amount |
| Settings | Values in the Value column | Setting names |
| Log | Nothing. Fix counts with **Set count** and mistakes with **History → remove** in the app, so every change is recorded. | |
| Inventory, Balances | Nothing. They're formulas. | |

Protected ranges show a warning before you edit something the app depends on. To roll back a mistake, use **File → Version history** in the sheet, or open a copy in the **Troop Closet backups** folder.

## Security notes

- The sheet is never shared with leaders. They reach the data only through the Apps Script, which checks their Google sign-in on every request against the Leaders tab.
- Removing someone from the Leaders tab (or unticking **Active**) signs them out on every device. **Sign out everywhere** does the same without removing them.
- Sessions last 30 days (Settings tab: **Session days**). Session tokens are stored hashed in Script Properties.
- `web/config.js` holds the Apps Script URL and the Google client ID. Neither is a secret.
- Keep troop details (troop number, names, prices) out of this repo. They belong in the sheet. The page shows them only after sign-in.

## Development

- Backend tests: `node test/backend.test.js` (runs `Code.js` against in-memory stand-ins for Google's services).
- Run the site locally with sample data: copy `apps-script/Code.js` and `test/fake-gas.js` into `web/demo/`, serve `web/` (for example `python3 -m http.server`), and open `http://localhost:8000/?demo=1`. Don't commit `web/demo/`.
- Libraries in `web/vendor/` are pinned copies; see `web/vendor/README.md`.

## Known limits

- **iPhone home-screen app and Google sign-in:** Google's sign-in popup can be unreliable inside a home-screen web app on some iOS versions. If sign-in doesn't complete there, sign in once in Safari, then reopen the home-screen icon, or just use it in Safari.
- **Apps Script quotas:** fine for a troop. Each request takes a second or two because it runs on Google's servers.
