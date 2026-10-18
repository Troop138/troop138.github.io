# Handing off the closet

Everything important is owned by troop accounts, not people, so a handoff is mostly passing along access.

## What the troop owns

| Thing | Owner |
|---|---|
| Google Sheet, Apps Script, backups folder, Google sign-in project | The troop Google account |
| This GitHub repo and the Pages site | The troop GitHub organization |
| Logins for the troop Google account (password, TOTP secret, backup codes) | The troop's shared password vault |

## Checklist for the outgoing admin

1. **Shared vault:** give the incoming person access to the vault entry with the troop Google account's password, TOTP secret and backup codes.
2. **Google account recovery:** in the troop Google account, update the recovery phone and recovery email to the incoming person (Google Account → Security).
3. **GitHub:** add the incoming person as an **Owner** of the troop GitHub organization.
4. **Leaders tab:** give the incoming person the **Admin** role (in the app: More → Leaders & access).
5. **Remove yourself:**
   - Untick **Active** on your Leaders row (this signs you out everywhere).
   - Leave the GitHub organization.
   - Remove your vault access.
   - If the sheet was shared with your personal Google account, remove that share.
6. **Rotate the shared secrets** so the old ones stop working:
   - Change the troop Google account password.
   - Set up the authenticator app again (Google Account → Security → 2-Step Verification → Authenticator app). This creates a new TOTP secret and the old one stops working.
   - Generate new backup codes.
   - Save all three in the vault.

The web address, home-screen icons, the QR code and every leader's sign-in keep working.

## Checklist for the incoming admin

1. Sign in to the troop Google account from the vault, and confirm you can open the sheet and the Apps Script project.
2. To change code, follow **Setup → 2. Push the code with clasp** in the README: install Node and clasp, run `clasp login` as the troop account, and create `.clasp.json` with the Script ID.
3. Read the **Editing the sheet by hand** section of the README.
4. Check the **Troop Closet backups** folder in the troop account's Drive has recent weekly copies.

## If something was set up under a personal account by mistake

- **Sheet owned by a personal account:** share it with the troop account, transfer ownership (Share → the troop account → Transfer ownership), then redeploy the Apps Script from the troop account (README step 5). The Web app URL changes, so update `web/config.js` and push.
- **Google sign-in project under a personal account:** create a new one as the troop account (README step 4) and update the client ID on the Settings tab and in `web/config.js`.
- **Repo under a personal GitHub account:** transfer it to the troop organization (repo Settings → Transfer). The site address changes, so leaders need the new link and a new QR code.
