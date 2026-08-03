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

**`port: 3001` must be unique across the whole App Store.** Nothing here can
verify that — check for a collision against the current `umbrel-apps` tree
before opening the PR, and pick another if 3001 is taken.

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

`APP_URL` is hardcoded to `http://umbrel.local:3001`. Umbrel does not expose the
device address as a compose variable — neither Immich nor Vaultwarden reference
one — so it cannot be derived.

It is the base for the QuickBooks OAuth redirect URI, so anyone reaching their
Umbrel by another name (a custom domain, a Tailscale address) must change it to
match what they register in the Intuit developer portal.

**Unverified and worth settling before submission:** Intuit requires HTTPS
redirect URIs for production apps, and `http://umbrel.local:3001` is neither
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

## Verified so far

- Manifest and compose parse; every required manifest field present
- Every `APP_RECAT_*` reference in compose is defined in `exports.sh`, and none
  is unused
- No published ports, no named volumes, all three images digest-pinned
- All three images confirmed multi-arch in their registries
- The package's env values pass the app's own production env schema, including
  the strict 64-hex `ENCRYPTION_KEY`, and local admin resolves to enabled

**Not verified:** no container has actually been started. Docker was unavailable
in the environment where this was authored, so migrations, healthcheck
behaviour, `app_proxy` routing, and the first-run wizard are all untested. Boot
it on a real Umbrel before submitting.
