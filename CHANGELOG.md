# Changelog

All notable changes to **AGY Monitor** are documented in this file.

## [1.1.1] - 2026-11

### English
- **Theme Unification & Defaults**:
  - Set `default` (Modern UI) as the default UI style and `table` (`List`) as the default step-details view (`List / Dots / Curve`), with Preferences ordered `Default` then `Liquid Glass`.
  - Unified structural geometry across **Default** and **Liquid Glass** (card/header spacing, border radii, scrollbar gutter, Settings dividers & top padding, capsule segmented controls & secondary buttons, and context bar styling).
  - Synced **Live Session Summary** across both themes: restored the outer `Session Summary` card and header in Liquid Glass with 4 nested glass tiles (no double `backdrop-filter`), and aligned Default Modern UI to the same 4-tile layout with centered labels, hidden per-cell icons, centered values, subtle low-contrast tile fill, and `<= 420px` 2×2 folding.
  - Unified all 4 **Usage Analytics** hero KPIs (`Total Tokens`, `Est. Cost`, `Cache Hit Rate`, `Output Speed`) to primary monochrome ink and removed the dot swatch next to the `Cache Hit Rate` header (keeping the 3 legend dots below the bar).
  - Strengthened Liquid Glass secondary/tertiary ink tokens (`--lg-ink-2` & `--lg-ink-3`) across light and dark modes for clearer contrast on the left time column and table headers.
- **Step Clock Time & Trend Chart Fixes**:
  - Replaced default `#step` first column (`step`) with wall-clock `time` (`HH:MM:SS`, full timestamp/UTC offset/`#step` in tooltip, turn-rail anchoring, legacy default column migration, and out-of-range timestamp fallback).
  - Updated the Dot-Matrix / Curve scrub pill in `StepsDetailView` to display `HH:MM:SS` clock time and aligned pointer hit-testing with chart horizontal padding (`1px` dots / `4px` curve).
  - Extended `StepTrendChart` color parsing (`parseColorWithAlpha` / `resolveCanvasColor`) to handle `hsl()`/`hsla()` (`grad`/`rad`/`turn`), CSS4 `rgb()`/`color(srgb ...)`, Canvas `fillStyle` probing, and invalid-color gradient guards — fixing solid color blocks on Default-theme curves and dot-matrix hover highlights.
- **Updater & Release Packaging**:
  - Prioritized SemVer comparison ahead of cross-timezone ZIP mtime (`compareBundleVersions`) to prevent reload deadlocks, with Info-ZIP `0x5455` UTC timestamps in `pack-release-zip.mjs`.

### 简体中文
- **主题风格统一与默认体验优化**：
  - 将默认界面风格设为 `默认`（Modern UI），调用明细默认视图设为 `列表`（`列表 / 点阵 / 曲线`），偏好设置顺序调整为 `默认`、`液态玻璃`。
  - 统一 **默认主题** 与 **液态玻璃主题** 的结构与几何规范（卡片与头部间距、圆角弧度、滚动条预留槽、设置项分隔线与首行留白、胶囊分段控件与次级按钮、上下文进度条与悬停读数样式）。
  - 同步 **「会话总览」** 结构：液态玻璃恢复外层卡片与 `会话总览` 标题，内部保留 4 个独立玻璃分块（禁用双层模糊）；默认主题同步为同款 4 分块居中标签/无格内角标/居中数值样式（`<= 420px` 自动折为 2×2），并采用柔和低对比度分块底色。
  - 统一 **「用量概览」** 4 项核心指标数值为主文本单色（浅色为黑色，深色自适应），并移除“缓存命中率”标题前的圆点（保留底部分布条三色图例）。
  - 调深液态玻璃浅色与深色模式下的 `--lg-ink-2` 与 `--lg-ink-3` 文字不透明度，提升明细表左侧时间列及表头等灰字的辨识度。
- **明细时间展示与曲线/点阵修复**：
  - 调用明细默认首列由 `#步序` 替换为时钟时间 `时间`（`HH:MM:SS`，悬浮提示保留完整日期、UTC 时区与 `#步号`，兼容旧版默认列自动迁移，并增加超范围时间戳回退保护）。
  - 点阵/曲线模式顶栏悬停胶囊改为显示 `HH:MM:SS` 时钟时间，并使指针命中坐标与曲线（`4px`）/ 点阵（`1px`）左右内边距保持一致。
  - 完善 `StepTrendChart` 的颜色透明度解析与画布探针回退（支持 `hsl()`/`hsla()`、`rgb()` 空格语法与百分比、`color(srgb ...)` 及异常色值保护），修复默认主题下速度/首字/缓存曲线变为实心色块与点阵悬浮实心色柱的问题。
- **更新器与打包可靠性**：
  - 修复跨时区 ZIP 修改时间导致的更新重载死循环（版本号比较优先于 mtime），并在发行打包中写入 Info-ZIP `0x5455` UTC 扩展时间戳。

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
