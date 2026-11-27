# AGENTS.md — AGY Monitor

Guidance for AI coding agents working in `infinitex233/AGY-Monitor`.

## 1. Identity & Scope Boundaries
- **Project**: **AGY Monitor** (Antigravity plugin `name: "agy-monitor"`). Keep `"name": "agy-monitor"` in `plugin.json` and the installed folder name `~/.gemini/config/plugins/agy-monitor` unchanged so sidecar URLs (`sidecar://agy-monitor/panel/`) and existing user data directories remain compatible.
- **Stack**: Pure Node.js ESM (**Node 22.5+** recommended for built-in `node:sqlite`), zero external npm dependencies, and a custom reactive DOM runtime (`defineComponent` + incremental `domPatch` + Shadow DOM host overlays).
- **License & Origin**: Forked from `yuhuan-dev/antigravity-usage-monitor` under **GPL-3.0** (`LICENSE`). Releases, updater URLs, and pricing catalog sync are decoupled to `infinitex233/AGY-Monitor` starting at `v1.0.0`.
- **Non-Goals (Do Not Reintroduce)**:
  - No Google OAuth flows, account switching, or PowerShell/DPAPI credential scripts.
  - No subscription quota UI cards/bars or quota reservation heuristics.
  - No host UI translation injection (`host-i18n`) or cross-client session migration tools.
  - Never modify host installation binaries or `app.asar`; desktop/IDE overlays must stay in-memory via CDP.

## 2. Repository Map
- **Root**: `plugin.json`, `mcp_config.json`, `pricing-catalog.json`, `CHANGELOG.md`, `LICENSE`, `README.md`, `README.zh-CN.md`, `assets/screenshots/*.png`, `.github/workflows/{release.yml,sync-upstream-pricing.yml}`.
- **`sidecars/panel/`**:
  - `main.mjs`, `sidecar.json`, `package.json`, `index.html`, `app.js` (generated), `styles.css` (generated).
  - Entrypoints: `mcp-entry.mjs` (0-tool MCP keepalive & shortcut bootstrap), `bridge-daemon.mjs`, `standalone.mjs` (headless web server; non-loopback requires `--token` or `USAGE_MONITOR_STANDALONE_TOKEN`), `cli-statusline.mjs`, `trajectory-metrics.mjs`.
  - `backend/`: Telemetry & storage (`telemetry-builder.mjs`, `usage-aggregator.mjs`, `trajectory-sqlite-ledger.mjs`, `trajectory-cache-store.mjs`, `cli-sqlite-reader.mjs`, `ls-rpc.mjs`, `ls-discovery.mjs`, `endpoint-registry.mjs`), config/updates (`config.mjs`, `settings-schema.mjs`, `pricing-catalog.mjs`, `plugin-updater.mjs`), host integration (`window-bridge.mjs`, `context-windows.mjs`, `cloudcode-proxy.mjs`, `desktop-launcher-config.mjs`, `cli-statusline-config.mjs`), and exports (`api-actions.mjs`, `file-exporter.mjs`, `fs-atomic.mjs`).
  - `shared/`: `window-bridge-protocol.mjs`, `settings-normalization.mjs`, `telemetry-display-rules.mjs`, `prompt-clean.mjs`, `workspace-uri.mjs`.
  - `src/`:
    - 3-tab UI: `views/LiveOverviewView.js` (mounts metrics, 10-channel context bar, active tasks + embedded `StepsDetailView.js`), `views/ConsumptionView.js` (`Today`, `24h`, `7d`, `14d`, `30d`, `All` 26-week full-fit heatmap, `Custom`), and single-page `views/SettingsView.js`.
    - Overlays & charts: `components/layout/WindowOverlayShell.js` (Shadow DOM capsule + hover preview + popover shell), `components/widgets/CapsuleBarWidget.js`, `components/charts/{TrendAreaChart.js,chartMotion.js}`.
    - Core & i18n: `core/{component.js,domPatch.js,reactive.js,formatters.js,reportExporter.js,fileExportClient.js,xlsxBuilder.js}`, `i18n/{index.js,zh-CN.js,en-US.js}`.
  - `scripts/`: `build-bundle.mjs` (bundles `src/` into `app.js` + `styles.css`), `pack-release-zip.mjs` (strict runtime whitelist packager outputting `dist/agy-monitor.zip`).
  - `test/`: Node built-in `node --test test/*.test.mjs` suite (`backend-harness.mjs` + `mock-dom.mjs`).

## 3. Key Invariants
1. **Bundler Order (`scripts/build-bundle.mjs`)**: Every module in `sidecars/panel/src/` must appear after its dependencies in `jsOrder`, and CSS files must match `cssOrder`. Always run `npm run build` after modifying anything under `src/` so `app.js` and `styles.css` stay in sync with source and E2E tests.
2. **i18n & Locale Safety**:
   - Keep `src/i18n/zh-CN.js` and `src/i18n/en-US.js` keys 100% identical (enforced by static tests scanning `t('...')`).
   - Tests asserting Chinese or English formatted output must explicitly call `setI18nLanguage(...)` and restore the prior locale in `t.after(...)`; otherwise Linux CI (`LANG=C.UTF-8`) fails under `language: 'auto'`.
3. **Styling**: Use theme/scale tokens (`var(--fs-*)`, etc.) in CSS views; avoid hardcoded `font-size: Npx` overrides in component styles.
4. **Update & Catalog Trust Boundary**:
   - `OFFICIAL_GITHUB_REPO` in `backend/config.mjs` must stay `'infinitex233/AGY-Monitor'` with `LEGACY_GITHUB_REPOS` empty.
   - `backend/pricing-catalog.mjs` intentionally ignores `latestPluginVersion` and resets `fetchedAtMs` if cached `sourceUrl` points outside the configured repository. Never accept upstream release versions into this fork's update state.
5. **Release Whitelist (`scripts/pack-release-zip.mjs`)**: Only runtime files belong in `dist/agy-monitor.zip`. Dev docs (`AGENTS.md`, `README*`), `src/`, `test/`, `scripts/`, and `.png` screenshots must remain excluded.
6. **Documentation Integrity**: Preserve `defineComponent` references in `README.md` / `README.zh-CN.md` (verified by parity tests) and keep upstream GPL-3.0 credit intact.

## 4. Common Commands & Workflows
Run from `sidecars/panel/`:
- Rebuild bundle (`app.js`, `styles.css`): `npm run build`
- Run full test suite (`node --test`): `npm test`
- Build clean release archive (`dist/agy-monitor.zip`): `npm run pack:release`
- Run standalone Web UI: `node standalone.mjs --port 8787` (add `--token <secret>` if non-loopback)

### Releasing a New Version (`vX.Y.Z`)
1. Bump version consistently in `plugin.json`, `sidecars/panel/package.json`, `pricing-catalog.json` (`latestPluginVersion`), and `CHANGELOG.md`.
2. Run `cd sidecars/panel && npm run build && npm test && npm run pack:release`.
3. Commit to `main`, create and push tag `vX.Y.Z` — `.github/workflows/release.yml` runs tests on `ubuntu-latest` and publishes `dist/agy-monitor.zip` to GitHub Releases.
4. To sync model pricing from upstream without pulling upstream version metadata, run the `Sync Upstream Pricing Catalog` workflow (`workflow_dispatch`) in GitHub Actions.

### Local Antigravity Desktop Testing Paths
- Installed plugin runtime: `~/.gemini/config/plugins/agy-monitor` (test clean installs by extracting `dist/agy-monitor.zip` so deleted dev/legacy files don't linger).
- Persistent runtime data & caches: `~/.gemini/antigravity/sidecar_data/agy-monitor/`.
