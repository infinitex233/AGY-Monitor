# Changelog

All notable changes to **AGY Monitor** are documented in this file.

## [1.1.0] - 2026-11

### Highlights
- **Switchable Apple Liquid Glass Theme (`uiTheme`, default: `liquid_glass`)**: Introduced a pure-neutral, crystal-clear frosted Liquid Glass visual system with specular meniscus rims, cursor-tracking sheen, and spring-eased transitions across the sidebar, floating popover, and hover cards — plus a live **UI Style (`Liquid Glass` / `Default`)** switcher in Preferences that preserves the classic upstream UI pixel-for-pixel.
- **2×2 Four-Metric Step Trend View (`Dots / Curve / List`)**: Added a universal 3-way switcher in the step details header (default: **Dots**) displaying Speed, TTFT, Cache Hit %, and Step Cost in synchronized 2×2 dot-matrix or smooth Bezier curves, with median-anchored P85 silent outlier soft-capping, dynamic cache floor scaling, and synchronized 4-cell hover scrubbing with an inline header step pill.
- **Pure Decode TPS (`MEASUREMENT_VERSION = 5`)**: Switched per-step and weighted-average speed calculations from end-to-end duration to pure decode duration (`max(totalDuration - TTFT, 50ms)`), excluding TTFT prefill/queue wait time and automatically recalculating legacy v4 caches.
- **Crystal Glass & Layout Polish**: Refined KPI tiles with subordinate units (`tok/s`, `s`) and a minimalist `$` cost icon, upgraded the 10-channel context window bar with segment hover dimming and inline readout, kept secondary popovers/tooltips high-opacity frosted, made floating popover height adapt cleanly to content, and aligned card gutters pixel-symmetrically with the top bar.

## [1.0.2] - 2026-11

### Fixes & Consistency
- **Repository Slug Synchronization**: Updated `OFFICIAL_GITHUB_REPO`, pricing catalog URLs, updater links, and documentation to `infinitex233/AGY-Monitor` (preventing false custom-fork detection on clones of `infinitex233/AGY-Monitor`).
- **Unified Branding**: Updated standalone web UI/CLI titles and page `<title>` from `Antigravity Usage Monitor` / `用量监控` to `AGY Monitor`.

## [1.0.1] - 2026-11

### Breaking Changes
- **Plugin ID & Archive Rename (`usage-monitor` → `agy-monitor`)**: Renamed the plugin identifier in `plugin.json`, installation directory (`~/.gemini/config/plugins/agy-monitor`), sidecar data directory (`~/.gemini/antigravity/sidecar_data/agy-monitor/`), and release archive (`agy-monitor.zip`).
- **Upgrade Note**: Existing `v1.0.0` installations should remove `~/.gemini/config/plugins/usage-monitor` and reinstall under `~/.gemini/config/plugins/agy-monitor` (legacy `usage-monitor` data is not auto-migrated).

## [1.0.0] - 2026-11

### Highlights
- **Focused 3-Tab Interface**: Streamlined navigation into **Live Monitor**, **Analytics**, and **Preferences**, embedding the call-details table directly beneath the session summary and context composition cards.
- **Topbar Capsule & Hover Quick Card**: Displays `Live Speed | TTFT | Live Cache Hit | Context %` in the titlebar capsule and `Live Speed | TTFT | Live Cache | Step Cost` on hover, with subscription quota widgets removed.
- **Refined Usage Analytics**: Added **24h** window preset, full-width adaptive **6-month (26-week)** calendar heatmap in **All** mode without horizontal clipping, color-coded token legend dots, and version-first compact model identifiers (e.g., `4-neon-high`, `4-hydrogen-high`).
- **Streamlined Security & Privacy Surface**: Removed OAuth account switching, PowerShell/DPAPI credential scripts, quota reservation heuristics, cross-client session migration, and host UI translation injection so runtime code stays strictly scoped to local telemetry.
- **Independent Versioning & Selective Pricing Sync**: Anchored releases and update checks to `infinitex233/antigravity-usage-monitor` starting at `v1.0.0`, paired with a manual GitHub Actions workflow to selectively pull upstream public pricing data.
