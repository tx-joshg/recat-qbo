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

## One thing that will generate support questions

### The setup wizard's admin email — handled upstream as of v0.1.1

`LOCAL_ADMIN_EMAIL` is `admin@recat.local`, surfaced to users as
`defaultUsername`. Local sign-in **only authenticates a user that already
exists and is an instance admin** — `authenticateLocalAdmin` looks the account
up, it never creates one. So the wizard has to create that exact address, or the
password Umbrel displays logs nobody in. With no outbound mail there is no magic
link either, which made it a dead end rather than an inconvenience.

The wizard now defaults to that address
([#47](https://github.com/tx-joshg/recat-qbo/pull/47)), so the displayed password
works as soon as setup finishes. **This is why the package must pin v0.1.1 or
later** — the v0.1.0 pin predates the fix and still strands users.

A user can still type a different address, and the wizard now warns that password
sign-in will not apply to it. That is the remaining support case, and it is a
deliberate choice rather than a trap.

### Connecting real QuickBooks needs an HTTPS address

**Confirmed against a real Intuit registration: Intuit will not accept a
non-HTTPS redirect URI for a production app.** `http://umbrel.local:3009` is
neither HTTPS nor public, so an Umbrel user cannot register it.

The public URL is therefore configurable at runtime (#38). An operator who
fronts their Umbrel with TLS — Tailscale Serve and Cloudflare Tunnel both issue
real certificates — sets that address in the first-run wizard's credentials step
or later under Settings → QuickBooks API access, and registers the redirect URI
it produces.

`APP_URL` in the compose file is the **starting value and the seed for origin
checking**, not a lock. Once an address is saved it wins. `APP_URL_LOCKED=true`
pins it for deployments that want the environment authoritative.

Without a TLS front, the built-in demo QuickBooks works fully; real books do not.
That is worth stating plainly in the store description rather than letting users
discover it at the Intuit step.

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
- **All 28 migrations apply** against an empty database on first boot, and do
  not re-run on the next boot
- The app serves; `/auth/methods` reports `localAdmin: true`
- The extractor is reachable from the server container over the app network
  (`/healthz` → 200) and is not published to the host
- `ReceiptCompanyConfig.enabled` defaults to `false` in the created schema, so
  extraction is off until an operator turns it on
- Postgres data lands in the `APP_DATA_DIR` bind mount, and **survives a full
  `down` / `up` cycle** — the admin account persisted and local sign-in still
  returned 200 afterwards, which is what Umbrel does on update
- `/api/setup/status` offers `localAdminEmail`, confirming the wizard fix is in
  the shipped image and not only in the source tree

### First-run flow, end to end

Re-run against the v0.1.1 pin, on a fresh database:

1. Fresh install reports `needsSetup: true` **and offers
   `localAdminEmail: admin@recat.local`** — the wizard fills it in
2. The wizard creates that administrator; with no SMTP it returns
   `delivered: false` plus a one-click link rather than failing
3. Local sign-in with the password Umbrel displays returns **HTTP 200**
4. `/api/setup/status` stops offering the address once an admin exists

**The order still matters.** Before step 2 those same credentials return
`401` — reproduced against this pin, not inferred. `authenticateLocalAdmin`
authenticates an existing instance admin and never creates one, so the account
must exist first. What changed is that a user who follows the wizard now lands on
the right address by default instead of having to know to type it.

### Still unverified

The v0.1.1 pin has been booted and the full first-run flow re-run against it, so
the gap the v0.1.0 notes recorded is closed. What remains:

**No TLS front, and no real Umbrel device.** Every run so far used a direct port
publish on a developer machine, not `app_proxy` on Umbrel hardware. The two
limitations that affected anyone fronting Recat with TLS are fixed and shipping
in this pin — [#39](https://github.com/tx-joshg/recat-qbo/issues/39), the OAuth
callback landing on an origin without the session cookie, and
[#40](https://github.com/tx-joshg/recat-qbo/issues/40), the MCP host guard
binding to the environment address, both closed in
[#42](https://github.com/tx-joshg/recat-qbo/pull/42) — but **neither has been
exercised through a TLS front.** They rest on their own tests and a non-proxied
server.

That matters more than it sounds: connecting real QuickBooks *requires* a TLS
front (see above), so the one path an operator must take to use real books is the
one path never tested end to end.

**No real QuickBooks connection has been made from this package.** The boots
verify the app serves, migrates, persists and signs in — not that an Intuit OAuth
round trip completes from an Umbrel install.

Boot it on a real Umbrel behind a TLS front, and connect a real company, before
submitting.
