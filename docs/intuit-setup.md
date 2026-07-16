# Getting your QuickBooks API credentials

Recat is self-hosted: **you** create a (free) app in Intuit's developer portal, and your deployment talks directly to QuickBooks with your own credentials. Nothing goes through anyone else's servers. This takes ~15 minutes for sandbox, plus a one-time compliance questionnaire for production access.

## 1. Create an Intuit developer account and app

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in (your existing QuickBooks login works)
2. **Dashboard → Create an app → QuickBooks Online and Payments**
3. Name it whatever you like (e.g. "My Recat"), select the **Accounting** scope (`com.intuit.quickbooks.accounting`)

## 2. Configure the redirect URI

1. In your app's **Keys & credentials** page, add a Redirect URI
2. Recat's setup wizard shows you the exact value — it is:

```
{YOUR_APP_URL}/auth/qbo/callback
e.g. https://recat.mydomain.com/auth/qbo/callback
     http://localhost:3001/auth/qbo/callback   (local dev)
```

Intuit requires HTTPS for production redirect URIs (localhost is exempt for development).

## 2b. EULA and Privacy Policy URLs

Intuit's app form asks for an End User License Agreement URL and a Privacy
Policy URL "hosted on your domain." **Your Recat deployment already serves
both** — paste these (the setup wizard shows them with copy buttons):

```
https://YOUR-RECAT-DOMAIN/eula
https://YOUR-RECAT-DOMAIN/privacy
```

They describe exactly what a self-hosted Recat instance stores and shares
(nothing leaves your server except QuickBooks API calls and your own SMTP).
They're templates — replace them if your jurisdiction needs specific language.

## 3. Grab your development (sandbox) keys

Copy the **Client ID** and **Client Secret** from the Development tab into Recat's setup wizard (or `.env`). Set `QBO_ENVIRONMENT=sandbox`. Intuit gives every developer account a sandbox company with fake data — connect it and try the full loop safely.

## 4. Get production keys (the compliance questionnaire)

To connect a **real** QuickBooks company, Intuit requires a one-time app assessment — even for private apps that will never be listed on their app store.

1. In your app, switch to the **Production** tab under Keys & credentials
2. Complete the required app details (name, description, URLs — your own domain is fine; for EULA/privacy-policy URLs a simple page on your domain works)
3. Complete the **compliance questionnaire**. It asks about your OAuth implementation, token handling, security, and error handling. Suggested answers for a Recat deployment:
   - *Hosting:* self-hosted on your own server/VPS
   - *OAuth 2.0:* yes — standard authorization-code flow; tokens stored encrypted at rest (AES-256-GCM); refresh tokens rotated and persisted on every refresh; refresh-on-expiry with 401 retry
   - *Who uses it:* internal tool for your own company (or your bookkeeping clients)
   - *APIs used:* Accounting API only (Purchase, Deposit, JournalEntry, Account, Vendor, Class, Department, CompanyInfo, CDC, Batch, Attachable)
   - *Change Data Capture:* yes, used for incremental sync
   - *Error handling / logging:* structured logs, sync-status page, append-only audit log of all writes
   - *Have you tested against sandbox:* **yes** (do this first — Intuit rejects "no")
4. Submit. Approval is typically days, not weeks.
5. Copy the production Client ID/Secret into Recat, set `QBO_ENVIRONMENT=production`, reconnect your company.

## 5. Set up the QuickBooks side (one-time bookkeeping step)

Recat watches a **holding account** — it cannot see the bank feed's "For Review" tab (no API can; Intuit doesn't expose it).

1. In QuickBooks, pick or create the holding account — most businesses use **"Ask My Accountant"** (Other Expense) or **"Uncategorized Expense"**
2. Recommended: create a **bank rule** that auto-adds all bank feed transactions to that account (Banking → Rules → New rule → apply to money out and/or money in → category = your holding account → **Auto-add**)
3. In Recat's setup wizard, select that account as the one to watch

From then on: bank feed → auto-added to holding account → appears in Recat → your team categorizes → Recat posts the correction back to QuickBooks.

**Coordinate with your accountant** if they use another tool (like Uncat) on the same books — two tools watching the same holding account will fight each other.

## Troubleshooting

- **"Redirect URI mismatch"** — the URI in the Intuit portal must match `{APP_URL}/auth/qbo/callback` exactly, scheme and all
- **Connected but no transactions appear** — nothing is in the holding account yet; check the bank rule is set to *auto-add* and transactions have been accepted
- **401 after weeks of inactivity** — refresh tokens expire after ~100 days without use; reconnect from Settings
- **429 errors** — you're rate-limited (rare); Recat backs off automatically, just wait
