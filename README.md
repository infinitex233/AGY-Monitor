<div align="center">

<img src="assets/agy-monitor-icon.png" alt="AGY Monitor icon" width="128" height="128" />

# AGY Monitor

**Apple Liquid Glass local telemetry & token analytics plugin for Google Antigravity**

Switchable Liquid Glass & Classic UI · 2×2 four-metric live trends · Pure Decode TPS · Zero npm dependencies · Zero credential access

[![Release](https://img.shields.io/github/v/release/infinitex233/AGY-Monitor?style=flat-square&color=007aff&label=release)](https://github.com/infinitex233/AGY-Monitor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/infinitex233/AGY-Monitor/total?style=flat-square&color=0ea5e9)](https://github.com/infinitex233/AGY-Monitor/releases)
[![Stars](https://img.shields.io/github/stars/infinitex233/AGY-Monitor?style=flat-square&color=f59e0b)](https://github.com/infinitex233/AGY-Monitor/stargazers)
[![License](https://img.shields.io/github/license/infinitex233/AGY-Monitor?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm-10b981?style=flat-square)](#local-development)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#client-support)
[![LINUX DO](https://img.shields.io/badge/Community-LINUX%20DO-1f2937?style=flat-square&logo=linux&logoColor=white)](https://linux.do)

[简体中文](README.zh-CN.md) · English

[Why AGY Monitor](#why-agy-monitor) · [Screenshots](#screenshots) · [Features](#features) · [Installation](#installation) · [Local Development](#local-development) · [License](#acknowledgments--license)

<br />

<img src="assets/screenshots/popover-live.png" alt="AGY Monitor Live Popover Preview" width="100%" />

<br />

[Latest Release (`v1.1.1`)](https://github.com/infinitex233/AGY-Monitor/releases/latest) · [Download `agy-monitor.zip`](https://github.com/infinitex233/AGY-Monitor/releases/latest/download/agy-monitor.zip)

</div>

---

## Why AGY Monitor

When working inside Antigravity, two questions matter most: **how fast is the current turn performing** (throughput, TTFT, live cache hit, context pressure), and **how many tokens and estimated dollars have been spent today and over recent weeks**.

**AGY Monitor** (streamlined from [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) and independently maintained from `v1.0.0`) strips away everything unrelated to pure telemetry:

- **Focused 3-Tab Interface**: Consolidated into **Live Monitor**, **Analytics**, and **Preferences** — removing subscription quota polling, account switching, quota reservation heuristics, cross-client session migration, and host UI translation injection.
- **Zero Account & Credential Surface**: Ships with no OAuth login flows and no PowerShell/DPAPI credential scripts. All metrics are read strictly from local Antigravity telemetry and trajectory caches.
- **Independent Releases & Pricing Sync**: Updates and releases target `infinitex233/AGY-Monitor`, while public API pricing in [`pricing-catalog.json`](pricing-catalog.json) can be synced selectively via a standalone GitHub Actions workflow.

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/capsule-hover.png" alt="Topbar Capsule and Hover Preview" width="100%" />
      <br />
      <b>Topbar Capsule &amp; Hover Card</b>
      <br />
      <sub>Live Speed, TTFT, Live Cache Hit, and Context Ring in the bar — plus Step Cost on hover</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/popover-live.png" alt="Live Monitor Popover" width="100%" />
      <br />
      <b>Live Monitor (Liquid Glass Popover)</b>
      <br />
      <sub>Pure Decode TPS, 10-channel context bar, active task status, and synchronized 2×2 four-metric dot-matrix / curve / table switch</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/popover-analytics.png" alt="Usage Analytics" width="100%" />
      <br />
      <b>Usage Analytics</b>
      <br />
      <sub>Today / 24h / 6-month heatmap windows, color-coded token legend dots, and smooth trend curve</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/sidebar-live.png" alt="Auxiliary Sidebar View" width="100%" />
      <br />
      <b>Auxiliary Sidebar View</b>
      <br />
      <sub>Full-height sidebar layout with 2×2 synchronized dot-matrix trends and full step diagnostics</sub>
    </td>
  </tr>
</table>

---

## Features

### 1. Topbar Capsule & Quick Hover Card
- **Non-Invasive Mounting**: Injects overlays cleanly in memory over local CDP — **never modifies** the host `app.asar` bundle.
- **Instant Telemetry at a Glance**: Displays **Live Speed (`tok/s`) | TTFT | Live Cache Hit | Context Ring %** right in the titlebar; hover for a 4-card snapshot (**Live Speed, TTFT, Live Cache, Step Cost**) and context channel bar, click to toggle the 3-tab popover, or right-click to refresh.

### 2. Live Monitor: Pure Decode TPS, Context Channels & 2×2 Trend Switch
- **Pure Decode TPS & Session Overview**: Measures true model output throughput (`outputTokens / max(totalDuration - TTFT, 50ms)`) alongside average TTFT, cache hit rate, and cumulative estimated cost with subordinate unit typography.
- **10-Channel Context Window**: Visualizes how context capacity is divided across model replies, tool outputs, user turns, subagent notices, compaction summaries, system prompts, system tools, MCP tools, skills, and user rules — with interactive hover dimming and inline readout pill.
- **2×2 Four-Metric Trends & Call Details (`Dots / Curve / List`)**: Switch effortlessly between synchronized 2×2 dot-matrix charts, smooth Bezier curves (Speed, TTFT, Cache %, Cost with silent P85 outlier soft-capping and 4-cell hover scrubbing), and the full sortable step table with `.xlsx` and Markdown export.
- **Version-First Compact Model Labels**: Cleaner short identifiers like `4-hydrogen-high` and `4-neon-high`.

### 3. Analytics: Trends, Full-Fit 6-Month Heatmap & Leaderboards
- **Preset & Custom Windows**: Inspect **Today**, **24h**, **7d**, **14d**, **30d**, **All**, or custom date spans.
- **Token Composition & Breakdown Bar**: Input, cache read, and output totals paired with color-coded legend dots and a proportional segment bar.
- **Full-Fit 6-Month Calendar Heatmap**: Selecting **All** renders a 26-week daily activity heatmap scaled cleanly to the panel width with zero edge clipping or horizontal scrolling; shorter windows display smooth cubic Bezier trend curves.
- **Multi-Dimensional Rankings**: Compare usage, estimated USD cost, cache hit %, speed, and TTFT across models, project workspaces, and sessions, with `.xlsx` and Markdown export support.

### 4. Streamlined Single-Page Preferences
- Configure language (`Auto` / `简体中文` / `English`), **UI Style (`Liquid Glass` / `Default`)**, accent theme, font scale (`sm / md / lg / xl`), model name formatting, mount mode (`Dual` / `Composer` / `Sidebar`), pricing catalog sync, update checks, and local cache rebuild on a single clean page.

---

## Client Support

| Client / Environment | Status Bar / Capsule | Monitor Panel | Offline Logs & SQLite | Modifies `app.asar` |
| :--- | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 Desktop** | Titlebar / Composer | Hover Popover + Auxiliary Pane | Yes | No |
| **Antigravity IDE** | Titlebar / Composer | Capsule Popover | Yes | No |
| **Antigravity CLI (`agy`)** | Terminal `statusLine` | Standalone Web (`--port`) | Yes (SQLite + `.pbtxt`) | No |
| **SSH Remote / Headless** | Isolated per endpoint | Popover / `--token` Web UI | Yes | No |

---

## Installation

> [!IMPORTANT]
> Keep the installed directory named **`agy-monitor`**. No `npm install` step is needed.

### Option 1: Download Release Archive (Recommended)

Download [`agy-monitor.zip`](https://github.com/infinitex233/AGY-Monitor/releases/latest/download/agy-monitor.zip) from [Releases](https://github.com/infinitex233/AGY-Monitor/releases/latest) and extract it into `~/.gemini/config/plugins/` so the resulting directory is `~/.gemini/config/plugins/agy-monitor`.

<details>
<summary>Windows PowerShell one-liner</summary>

```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/infinitex233/AGY-Monitor/releases/latest/download/agy-monitor.zip" -OutFile "$env:TEMP\agy-monitor.zip"
Expand-Archive -Path "$env:TEMP\agy-monitor.zip" -DestinationPath $pluginsDir -Force
```

</details>

### Option 2: Git Clone

```powershell
# Windows (PowerShell)
git clone --filter=blob:none --single-branch https://github.com/infinitex233/AGY-Monitor.git "$env:USERPROFILE\.gemini\config\plugins\agy-monitor"
```

```bash
# macOS / Linux
git clone --filter=blob:none --single-branch https://github.com/infinitex233/AGY-Monitor.git ~/.gemini/config/plugins/agy-monitor
```

### Enable & Standalone Web Mode

1. Open **Customizations → Installed** in Antigravity and enable **AGY Monitor** (`agy-monitor`).
2. For **Antigravity IDE**, restart the IDE once after enabling to mount the titlebar capsule.
3. For headless/remote environments, launch the built-in standalone server (non-loopback bindings require `--token <secret>` or `USAGE_MONITOR_STANDALONE_TOKEN`):

```bash
node ~/.gemini/config/plugins/agy-monitor/sidecars/panel/standalone.mjs --port 8787
```

Settings and local trajectory caches persist under `~/.gemini/antigravity/sidecar_data/agy-monitor/`.

---

## Local Development

Both backend and frontend use pure Node.js ESM (Node.js 22.5+ recommended for built-in `node:sqlite`) and a lightweight custom reactive UI runtime (`defineComponent` + incremental DOM patching with Shadow DOM isolation) — **zero external npm dependencies**:

```bash
cd sidecars/panel

# Rebuild app.js and styles.css after editing src/
npm run build

# Run full unit & integration test suite
npm test

# Package clean runtime archive (dist/agy-monitor.zip)
npm run pack:release
```

---

## Acknowledgments & License

- **Upstream Attribution**: Forked and streamlined from [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor). Huge thanks to the upstream author for the foundational telemetry collector, protobuf/SQLite readers, and overlay bridge architecture.
- **Community**: Thanks to the [LINUX DO](https://linux.do) community for providing an open and welcoming space for technical discussion and feedback.
- **License**: Distributed under the [GNU General Public License v3.0](LICENSE).
