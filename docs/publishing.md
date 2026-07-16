# Publishing checklist — Recat QBO

Everything to do when creating the public GitHub repository. The repo
description and topics below are the agreed metadata — paste/apply verbatim.

## 1. Create the repository

```bash
gh repo create recat-qbo --public \
  --description "Self-hosted transaction categorization and review queue for QuickBooks Online. An open-source alternative to Uncat." \
  --source . --push
```

## 2. Apply topics

```bash
gh repo edit --add-topic quickbooks-online \
  --add-topic quickbooks \
  --add-topic qbo \
  --add-topic bookkeeping \
  --add-topic accounting \
  --add-topic transaction-categorization \
  --add-topic bank-transactions \
  --add-topic expense-categorization \
  --add-topic self-hosted \
  --add-topic open-source \
  --add-topic docker \
  --add-topic uncat-alternative
```

## 3. Before the first push

- [ ] ~~Replace `<repo-url>`~~ done — README points at github.com/tx-joshg/recat-qbo
- [ ] Confirm `.env` is NOT tracked (`git status --ignored | grep .env` — only `.env.example` ships)
- [ ] Confirm no real Intuit credentials or SMTP passwords in any tracked file
- [ ] `npm run typecheck && npm test && npm run build` green

## 4. After creation

- [ ] Publish the Docker image: `ghcr.io/tx-joshg/recat-qbo` (compose file already references it)
- [ ] Enable Issues + Discussions; add issue templates
- [ ] Social preview image: `docs/screenshots/queue.png` works well (Settings → Social preview)

## Naming note

The public project name is **Recat QBO** (repo: `recat-qbo`). The in-app brand
stays **"Recat"** — the logo, page titles, and UI copy match the design
prototype pixel-for-pixel, and the QBO suffix exists for discovery, not chrome.
