# Changelog

All notable changes to **AGY Monitor** are documented in this file.

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
