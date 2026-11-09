# Agent notes

## Project

`shibumi-server` is a Bun service that receives signed GitHub push webhooks and deploys configured applications with rootless Podman Compose.

## Commands

```bash
bun install
bun test
bun check       # native checker; development requires Bun >=1.4.4
bun pm pack --dry-run
```

The real Podman integration test is opt-in:

```bash
SHIBUMI_INTEGRATION=1 bun test test/integration.test.ts
```

Use `SHIBUMI_COMPOSE_COMMAND=podman-compose` on hosts with the standalone Compose frontend.

## Site styles

The marketing site's shared design layer is vendored: `site/shibumi.css` is a copy of the canonical file in the shibumistack.dev repo (`public/shibumi.css`). Do not edit the vendored copy; edit the canonical file and run `scripts/sync-shibumi-css.sh` to re-pull. `site/styles.css` holds only site-specific rules layered after it. Typescale is 12/14/16/18/21/25 in rem, never below 12px, never off-scale values; body is sans, headings serif, mono stack leads with `ui-monospace`.

## Releases

Development/release checks use Bun >=1.4.4 and native `bun check --no-script`; keep `@types/bun` but no direct `typescript` dependency. The server runtime engine floor remains unchanged. After dependency edits, regenerate `bun.lock` and copy it byte-for-byte to `runtime-lock.json` before packaging.

Create and push matching `v${version}` Git tag at release commit before `npm publish`. Postpublish website sync verifies tagged `install.sh`; publishing first uploads package but leaves sync failed.

The vendored Ship client (`scripts/ship.ts`) is byte-locked to the published immutable snapshot in `scripts/ship.lock.json`. Never hand-edit it; to upgrade, bump the lock to the new `vN.ts` URL + sha256, run `bun run sync:ship`, review, commit. `test/ship-sync.test.ts` fails the build on drift, so the client updates as a deliberate lock + sync step, not a silent edit.

## Upstream releases (shibumistack.dev)

shibumistack.dev is the canonical source for shared artifacts; when it publishes a new one, this repo owes a follow-up. The full flow lives in `create-shibumi/PUBLISHING.md` → "Ship client releases".

| Published on shibumistack.dev | Follow-up here |
|---|---|
| Ship client (`/ship/latest.ts` → new `vN.ts`) | Bump `scripts/ship.lock.json` to the new URL + sha256, `bun run sync:ship`, review, commit. `test/ship-sync.test.ts` fails the build on drift. |
| `public/shibumi.css` (design tokens) | Re-run `scripts/sync-shibumi-css.sh`, review, commit. Never hand-edit the vendored copy. |
| create-shibumi CLI / shibumi-server releases | No action here; the site repo bumps its `createShibumiVersion` / `shibumiServerVersion` fields. |


## Security invariants

- Reject malformed event, delivery UUID, and signature headers before reading the request body; verify `X-Hub-Signature-256` over the raw body before parsing payload data.
- Compare signatures in constant time and preserve bounded replay protection for accepted `X-GitHub-Delivery` IDs.
- Match repository and exact branch against machine-local configuration.
- Accept only full lowercase 40-character commit SHAs.
- Prebuilt images require exact app ID, repository, commit revision, Git source-tree, tag, and server-platform identity. Resolve source tree independently after webhook fetch; never trust upload labels alone.
- Never interpolate payload or config values into a shell command; use argument arrays.
- Keep the HTTP listener and app ports on loopback behind Caddy. Managed app proxies retain a 20-second `lb_try_duration` during Compose replacement; deployment logs record health readiness against that retry budget.
- Keep webhook secrets, credentials, real machine config, and deployment state out of Git and npm packages.
- Preserve the per-app lock: concurrent deployment requests return `409` and are not queued.
- Failed preflights, fetches, Compose validation, builds, or optional app tests must not run `compose up`.
- After a successful health check, retain the active app image and `retainedRollbackImages` earlier successful images (one by default, two successful images total), then prune dangling Podman images. Retention and cleanup are best effort: log failures without failing a healthy deployment. Never broaden cleanup to `--all` or `system prune`.
- Preserve host resource guards: preflight memory/disk floors, a cancellable build deadline, systemd ceilings, and per-app Compose limits.
- The systemd unit must execute a pinned local package copy, never an unpinned `bunx` command. Init must preserve machine config/secrets. Repeating an existing domain registration must preserve its checkout, config, secret, and Caddy state while restarting the service; conflicting settings fail closed.
- Wrap imported `node:dns/promises` functions in arrow functions before storing them on the DNS resolver object. Bun fails those functions when invoked with the resolver object as `this`. Preserve lookup errors, retry transient failures, fall back to the OS resolver, and report `unknown` separately; never turn resolver failure into missing DNS.
- Installed releases expose compatible `shis` and `shibumi-server` launchers. Human-facing help and interactive flows brand themselves exactly `渋み  shis (shibumi-server)` and prefer concise `shis` commands. Keep Clack's native interface and color only branding persimmon through `terminal-ui.ts`. Respect `NO_COLOR`, non-TTY output, and `TERM=dumb`; machine-readable JSON commands stay free of decorative output.
- Verified webhook deployments write bounded mode-`0600` history without payloads, signatures, secrets, or request headers. Keep only latest per-app deployment log, mode `0600`, bounded to 256 KiB, with ANSI/control characters stripped. Rollback restores the one retained previous image without fetching or building, verifies health, rotates retention so the replaced image becomes the next rollback image, and restores the current image if rollback fails. Capture the running image before cutover and restore it when startup or health checks fail.
- No-argument interactive setup checks Git, Caddy, rootless Podman, and the systemd user session before installing the pinned service and `~/.local/bin/shibumi-server` launcher. `add <domain>` checks DNS, detects existing Caddy state, accepts canonical repository names or HTTPS GitHub URLs, prompts for missing repository and checkout values with a user-owned `~/shibumi/<app-id>` checkout default, then assigns the first available port above `9000`; keep complete flags available for automation. `add --dry-run` must follow the same detection, prompt, port-selection, and validation path while making no config, secret, filesystem, systemd, container, Caddy, or GitHub changes. App-owned tests are optional and available only through explicit config or `add` arguments; never invoke them through a shell.
- Dynamically import interactive prompt dependencies so `serve` and `check` do not load `@clack/prompts`. Each pinned release must include `runtime-lock.json`, kept byte-identical to `bun.lock`, rename it to `bun.lock` during staging, and install production dependencies with `--frozen-lockfile --production --ignore-scripts` before activation; interactive commands run from that self-contained release.
- Caddy changes require explicit confirmation before sudo handles password directly. Keep installed root helper constrained to schema-validated JSON over stdin, computed paths, loopback upstreams, fixed directives, bounded logs, atomic writes, full validation, reload, and rollback. `caddy-refresh` may replace only exact managed app upstream line with fixed retry block; preserve every other directive. Never accept arbitrary Caddy text, commands, paths, or upstream hosts. Managed new/rewrite sites use `/etc/caddy/sites.d/<app-id>.caddy`; existing-domain preserve/cutover routes use `/etc/caddy/sites.d/<app-id>.routes`. `caddy-refresh` identifies whichever single fragment exists. Verification commands must inspect `<app-id>.*` or both extensions, never assume `.caddy`. Root helper version must include `APP_RETRY_BUDGET_MS` so a budget change reinstalls the root-owned renderer; change its schema prefix for any other helper behavior change. Retry-budget migration may replace exactly one existing numeric `lb_try_duration <N>ms` option, but must reject every other upstream option.
- Commit-safe `client-config` output must never include secrets, checkout paths, SSH users, local aliases, or credentials. Webhook secret handoff is JSON over explicit SSH and must not print in interactive prose. Successful manual registration ends with a concise branded summary and exact local ship installer command, never raw secret paths or placeholder commands. Status snapshots stay mode-restricted and expose no logs or secrets.
- User-run CLI commands check the npm registry for newer stable releases, suggest `shis update` when outdated, and fail open on timeout or registry errors. Keep `serve` startup independent from this network check. Explicit update resolves one validated stable version, installs that exact npm release through Bun, and reuses idempotent `init` so config and secrets survive.
- Release version digits must add up to one of Mauricio's preferred totals: `1`, `2`, `3`, `5`, `7`, or `9`. Enforce this in package tests; `0.3.2` is valid because its digits total `5`.
- Every user-facing CLI failure includes a concrete `Next:` action or command. Syntax errors may show usage; operational failures never dump full help.
- Existing clean app checkouts fast-forward to configured origin/ref during registration. Dirty, diverged, inaccessible, or source-incomplete checkouts fail with specific recovery; never reset or discard user work.
- `list` probes every configured internal health URL concurrently, uses green status for healthy responses and red for non-success or unreachable responses, and prints explicit health detail. `remove` uses branded output. Legacy `composeCommand: ["podman"]` config normalizes to `["podman", "compose"]` before deploy or removal. Default app removal deletes Shibumi config, its secret, deployment status, managed Caddy route, and app containers while preserving checkout, volumes, images, and GitHub webhook. Last-app removal stops the service. Caddy removal stays constrained, backed up, validated, reloaded, and rolled back by the root helper.
- Normal unit tests must fake Git, Podman, and systemd. Real integration tests must use unique disposable projects and clean up.

## Gotchas

- The real Podman integration fixture uses fully qualified `docker.io/oven/bun:alpine` so it works without host short-name aliases or registry-search config. This keeps the same floating official Bun image; do not replace it with a Docker-to-Podman alias workaround. Its logger prints deployment failures rather than hiding the cause behind a final HTTP connection error.

- `scripts/dev-site.ts` needs `idleTimeout: 0`: `/__hmr` EventSource idles over Bun.serve's 10-second default and warns.
- Dev preview does not claim port 9100 from an existing listener. Kill stale PID before starting `bun dev`.
- Body-copy selectors must exclude label classes directly; `.scope-copy > p:not(.eyebrow,.fine-print)` overrode `.scope-label` font size.
- Docs Markdown output starts at `docs/`, so images and routes must remain portable between GitHub and `server.shibumistack.dev`.
- `scripts/ship.ts` must match reviewed upstream client. Local edits trigger installer `owned changes`; publish upstream immutable version, then sync.
- `oven/bun:1.4.0-slim` compressed layers are ~25 MiB (62%) larger than Alpine on ARM64 and AMD64. `slim` name does not mean smaller here.
- The Ship client (`../shibumistack.dev/scripts/ship.ts`) talks to the server ONLY through `shis` subcommands over SSH (`shis image-load`, `client-config`, `webhook-secret`, `env`, ...). It never scps files or knows the app checkout path. Any new client capability = a new `shis` subcommand, not a file push.
- Per-app secrets: `shis env set|list|rm <app-id>` stores `<config>/env/<app-id>.env` (0600); `set` reads KEY=VALUE from stdin (never argv). Injected at deploy via `composeOverride` in `deploy.ts` (merged into the service `environment:` block, values JSON.stringify'd = safe YAML scalar). Reserved `SHIBUMI_COMMIT`/`SHIBUMI_DEPLOYED_AT` win. Changing env needs a redeploy to apply. app-id is validated against the app-id grammar before it becomes a path.

## Public versus local

Public files use generic `myapp`/`example.com` examples. Do not add hostnames, usernames, real paths, ports, webhook URLs, or app inventory from a specific installation. Actual configuration belongs outside the checkout.
- Source installs on a server (`git pull && bun src/cli.ts init`) are a NO-OP when `releases/<version>` already exists: init skips the copy for a known version. Same-version code changes need `rm -rf ~/.local/share/shibumi-server/releases/<version>` before init (safe while the service runs; init re-stages and swaps the `current` symlink). npm-flow updates always bump the version, so only source installs hit this.
