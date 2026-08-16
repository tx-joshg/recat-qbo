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

**`port: 3009`** — re-checked against the App Store index on 2026-08-15 (394
apps, up from 391 twelve days earlier): no package references `3009`, and the app
id `recat` is still unclaimed. `3001` was taken by `ride-the-lightning`. Re-check
again immediately before submitting, since the store moves.

Note the split: `port` is the host-facing app_proxy port and must be unique,
while `APP_PORT` and the container's `PORT` stay `3001` — that is Recat's own
listen port and is not visible to the host. `APP_URL` follows the *host-facing*
port, because it is what a browser hits and what the QuickBooks redirect URI is
built from.

**`gallery: []` is correct — do not fill it in.** Umbrel's packaging guidance
says new packages ship an empty gallery and the Umbrel team creates and hosts the
App Store assets before merge. Screenshots and the logo belong in the upstream PR
body, not committed here. The same applies to `icon`, which official packages omit
entirely.

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
works as soon as setup finishes. **The package must pin v0.1.2 or later** —
v0.1.0 predates this fix and strands users, and v0.1.1 predates the first-run
claim guard described below.

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

### Umbrel's dashboard auth must be off, and that has a consequence

`PROXY_AUTH_ADD` defaults to `true`, which fronts the app with Umbrel dashboard
authentication. That works from the dashboard origin, where the browser carries
the session cookie. Behind a TLS front it does not: `app_proxy` redirects to
`http://127.0.0.1:2000`, an address nothing outside the box can reach.

Measured on a real device by [@salmonumbrella](https://github.com/salmonumbrella)
against the package as shipped: **200 on loopback, 502 through Tailscale Serve,
502 on `/auth/qbo/callback`.** So the Intuit callback can never land, and real
QuickBooks cannot be connected at all.

Whitelisting only the callback with `PROXY_AUTH_WHITELIST` does not solve it —
every UI request would still redirect to the unreachable address, leaving the app
unusable through the very front it needs. The package therefore sets
`PROXY_AUTH_ADD: 'false'` and relies on Recat's own authentication: sessions,
magic links, the rate-limited local admin password, and per-company roles.

**The consequence, and what closes it.** Removing Umbrel's layer means Recat's
own auth is the only gate — and first-run is necessarily ungated, because
somebody has to be able to create the first account. Before that account exists
`POST /api/setup/admin` takes any email, and with no SMTP it returns a one-click
sign-in link directly in the response. Left alone, anyone who could reach an
un-set-up instance could claim it.

**The wizard now requires the app password Umbrel displays** before it will
create that first administrator
([#53](https://github.com/tx-joshg/recat-qbo/issues/53)). No new secret: the
deployment already shows `${APP_PASSWORD}` on the Recat app page, so requiring it
proves the caller can see the device. Attempts are rate limited, so a public
instance is not a free brute-force target. Deployments with no `LOCAL_ADMIN_*`
configured are unaffected and still set up without a password.

**And `POST /auth/magic-link` is locked down on local-admin deployments** —
the first version of the guard was bypassable through it, caught by codex review
after v0.1.2 shipped. That unauthenticated route used to bootstrap the first
admin for whoever asked, and to return the sign-in link in the response body
whenever SMTP was absent and no real company was connected — an admin session
for the asking, since the admin address is published right in this manifest.
When `LOCAL_ADMIN_*` is configured it now does neither: the password-gated
wizard is the only bootstrap, and issued links reach the server log only (which
the login screen already points to). Issuance is also rate limited and expired
tokens are pruned, so anonymous traffic cannot grow the database or logs
without bound. `ALLOW_DEV_LOGIN=true` restores dev behavior explicitly.

Still worth doing, because defence in depth costs nothing here:

- **Prefer a private front.** Tailscale Serve keeps the app on your tailnet;
  Tailscale Funnel and Cloudflare Tunnel publish to the open internet. All
  satisfy Intuit's HTTPS requirement, but only one limits who can reach the box
  at all.
- **Finish the wizard early**, from the dashboard on your LAN.

The window was never introduced by turning proxy auth off — it exists on any
Recat deployment reachable before setup — but proxy auth was what happened to
cover it on Umbrel, which is what made closing it properly worth doing.

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
- **The first-run claim guard is in the shipped image** (re-verified against the
  v0.1.2 pin): a claim with no password and a claim with the wrong one both return
  `401` with no sign-in link in the body, the instance stays un-set-up, and the
  password Umbrel displays then creates the admin and signs in

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

### Verified on real hardware (v0.1.1)

[@salmonumbrella](https://github.com/salmonumbrella) ran the package on an actual
Umbrel device, which closes the gap every earlier note recorded as outstanding.
Their report, against `umbrel/recat/` as shipped:

1. **Installs and boots clean** from the package directory
2. **The wizard completes and the displayed password signs you in** — tested
   against an empty database, before restoring anything
3. **QuickBooks connects** — with the `PROXY_AUTH_ADD` fix below

Finding (3) is what produced that fix: without it, `app_proxy` redirects to
`http://127.0.0.1:2000` and the Intuit callback returns 502 through a TLS front.
The measurements are in the HTTPS section above.

This also means [#39](https://github.com/tx-joshg/recat-qbo/issues/39) and
[#40](https://github.com/tx-joshg/recat-qbo/issues/40) — the OAuth callback origin
and the MCP host guard, both closed in
[#42](https://github.com/tx-joshg/recat-qbo/pull/42) — have finally been exercised
*through* a real TLS front rather than resting on their own tests.

### Still unverified

**The maintainer has no Umbrel device**, so the hardware report above is a
contributor's rather than something reproduced here. It is specific and measured,
which is why it was acted on, but it is one person on one device.

**Nothing since that report has been tested on hardware.** The `PROXY_AUTH_ADD`
fix, the first-run claim guard, and the v0.1.2 pin have all been verified only on
a developer machine. The corrected package has never been round-tripped back
through a device.

**`submission:` is still `PENDING`** — it cannot be filled until the upstream pull
request exists. (`gallery: []` is *not* an outstanding item; see above.)
