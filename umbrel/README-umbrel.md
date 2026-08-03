# Umbrel app package

Source of truth for the Recat entry in the [Umbrel App Store](https://github.com/getumbrel/umbrel-apps).
Submitting means copying `recat/` into that repository as `recat/` and opening a
pull request; keeping it here means the package is versioned with the code it
packages.

```
recat/
  umbrel-app.yml        manifest
  docker-compose.yml    server + postgres + receipt-extractor, behind app_proxy
  exports.sh            derived per-install secrets
  data/postgres/        bind-mount target (.gitkeep)
```

## Before submitting

**`submission` is a placeholder.** It must be the URL of the upstream pull
request, which does not exist until you open it. Umbrel will reject the
manifest with `PENDING` in place.

**`port: 3009`** — checked against the full App Store index (391 apps, current
as of 2026-08-03). `3001` was taken by `ride-the-lightning`; `3009` is the
nearest free port and nothing else references it. The app id `recat` is also
unclaimed. Re-check before submitting, since the store moves.

Note the split: `port` is the host-facing app_proxy port and must be unique,
while `APP_PORT` and the container's `PORT` stay `3001` — that is Recat's own
listen port and is not visible to the host. `APP_URL` follows the *host-facing*
port, because it is what a browser hits and what the QuickBooks redirect URI is
built from.

**Images are pinned by digest** and must be re-pinned on every release:

```bash
# after the publish workflow runs for a new tag
docker buildx imagetools inspect ghcr.io/tx-joshg/recat-qbo:vX.Y.Z
docker buildx imagetools inspect ghcr.io/tx-joshg/recat-qbo/receipt-extractor:vX.Y.Z
```

Both images must list `linux/amd64` and `linux/arm64` — a large share of Umbrel
devices are ARM, and a single-arch image simply fails to pull there.

## Two things that will generate support questions

### The setup wizard's admin email must match

`LOCAL_ADMIN_EMAIL` is `admin@recat.local`, surfaced to users as
`defaultUsername`. Local sign-in **only authenticates a user that already
exists and is an instance admin** — `authenticateLocalAdmin` looks the account
up, it never creates one. So the wizard has to create that exact address as the
first administrator, or the password Umbrel displays will not log anyone in.

This matters more on Umbrel than elsewhere: there is no outbound mail, so
magic-link sign-in cannot deliver, and local sign-in is the only way back in.

Worth considering upstream: let the first-run wizard adopt `LOCAL_ADMIN_EMAIL`
as the default administrator address, which would remove the coordination
entirely.

### APP_URL and the QuickBooks redirect

`APP_URL` is hardcoded to `http://umbrel.local:3009`. Umbrel does not expose the
device address as a compose variable — neither Immich nor Vaultwarden reference
one — so it cannot be derived.

It is the base for the QuickBooks OAuth redirect URI, so anyone reaching their
Umbrel by another name (a custom domain, a Tailscale address) must change it to
match what they register in the Intuit developer portal.

**Unverified and worth settling before submission:** Intuit requires HTTPS
redirect URIs for production apps, and `http://umbrel.local:3009` is neither
HTTPS nor a public hostname. If Intuit rejects it, Umbrel users can run the
built-in demo QuickBooks but may not be able to connect real books without
fronting the app with TLS. Confirm against a real Intuit app registration before
listing, because it decides whether the package delivers the product or only a
demo of it.

## Notes on specific choices

**No `TRUSTED_PROXY_IPS`.** The `app_proxy` container's address is assigned by
Docker and is not exposed as a variable. Unset is the safe failure mode:
`X-Forwarded-For` is ignored, so per-IP rate limiting counts the proxy rather
than the client. Trusting a guessed CIDR would instead let a client spoof its
source address.

**Bind mount, not a named volume.** Umbrel backs up and restores
`${APP_DATA_DIR}` and recreates containers on update; a named volume would sit
outside that.

**The receipt extractor is included.** It has no published image until the
publish workflow ships it, which is why that came first — an Umbrel package can
only pull, never build. Receipt extraction is still opt-in and off by default,
and enabling it sends receipt images to whichever provider the operator
configures.

## Verified by running it

Booted from the pinned digests on an **arm64** host — the architecture most
Umbrel devices use — with `derive_entropy` values simulated and `app_proxy`
replaced by a direct port publish, so the server, database and extractor
definitions ran exactly as they ship.

- All three digests pull and resolve on arm64
- Containers start, Postgres and the extractor report healthy, the server waits
  on both
- **All 26 migrations apply** against an empty database on first boot
- The app serves; `/auth/methods` reports `localAdmin: true`
- The extractor is reachable from the server container over the app network
  (`/healthz` → 200) and is not published to the host
- `ReceiptCompanyConfig.enabled` defaults to `false` in the created schema, so
  extraction is off until an operator turns it on
- Postgres data lands in the `APP_DATA_DIR` bind mount, and **survives a full
  `down` / `up` cycle** — the admin account and its session both persisted,
  which is what Umbrel does on update

### First-run flow, end to end

1. Fresh install reports `needsSetup: true`
2. The wizard creates the first instance admin; with no SMTP it returns
   `delivered: false` plus a one-click link rather than failing
3. Local sign-in with the password Umbrel displays then returns HTTP 200

**The order matters.** Before step 2 those same credentials return
`401 INVALID_CREDENTIALS` — reproduced, not inferred. `authenticateLocalAdmin`
authenticates an existing instance admin and never creates one, so the account
must exist first. A user who tries the displayed password before finishing the
wizard will be told it is wrong.

That is the strongest argument for having the wizard default its admin address
to `LOCAL_ADMIN_EMAIL`: it would make the displayed credential correct at every
point rather than only after step 2.

### Still unverified

`GET /api/setup/status` reports the redirect URI the app will use:
`http://umbrel.local:3009/auth/qbo/callback`. Whether Intuit accepts a
non-HTTPS, non-public redirect URI for a production app is still open, and it
decides whether Umbrel users can connect real books or only run the demo.
Answerable in minutes against a real Intuit app registration.
