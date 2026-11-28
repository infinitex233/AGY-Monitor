# Changelog

All notable changes to **AGY Monitor** are documented in this file.

## [1.2.4] - 2026-11

### 更新内容
- **液态玻璃主题表头与全界面表面穿透修复**：
  - 修复深色与浅色液态玻璃（Liquid Glass）下「明细」表格粘性表头（`时间 / 模型 / 速度 / 首字 / 缓存命中率 / 费用`）因高不透明度 `--lg-sticky-th-bg` 产生尖角硬色块的问题：静止态完全透明融入玻璃卡片并保留底部分割线，垂直滚动时切换为圆角半透底色，并通过 `tbody` 的 `clip-path: inset(var(--step-scroll-top, 0px) 0 0)` 防止滚动行文字透底；同时在滚动、视口刷新、行高重校准及数据重渲染后实时同步裁剪状态，避免缩表或切换会话后残留误裁剪。
  - 修复液态玻璃下展开态下拉框、搜索框、日期时间控件与表格预览混入不透明现代主题色值的问题；补齐根/Shadow Host 主题选择器与文字墨色变量，并为填充型芯片/幽灵按钮/主题色卡提供更清晰的悬停提亮（`--lg-control-hover`），统一调用明细与模型用量双表头字色（`--lg-ink-2`）。
  - 修复对话轮次导轨空心起点圆点遮盖底色（改为 `mask-image` 透出玻璃卡片）、异常筛选条与桥接提示条背景、用量热力图色阶/月界线及「其他」分段（`--cons-other-seg`）混入不透明 `--surface-panel` 的问题。
  - 优化多会话实时看板浮层（`.wm-multi-panel`）：移除内部任务行双层模糊与 hover 矩形高光残留，强化磨砂底色与次级文字对比度。
- **文档与预览图**：精简中英 README 预览图说明并修正实时预览截图中异常 TPS 示例值。

### English
- **Liquid Glass Table Header & Surface Bleed Fixes**:
  - Fixed the dark/light Liquid Glass Steps Detail sticky header (`Time / Model / Speed / TTFT / Cache Hit / Cost`) rendering as a stark opaque rectangle (`--lg-sticky-th-bg`): removed the opaque header fill token so the header blends seamlessly into glass cards at rest with a hairline divider, switches to a clean rounded frosted bar on vertical scroll, and clips `tbody` via `clip-path: inset(var(--step-scroll-top, 0px) 0 0)` to prevent scrolled rows from showing through; synchronized scroll/clip state across scroll events, viewport refresh, height calibration, and row re-renders.
  - Fixed opaque Modern UI fills leaking into open Liquid Glass dropdowns, search inputs, date/time controls, and table previews; expanded root/Shadow Host token selectors, added stronger hover elevation (`--lg-control-hover`) for filled chips and ghost buttons while preserving subtle row hover, and unified table header ink (`--lg-ink-2`) with accent ink on sorted columns.
  - Fixed remaining `--surface-panel` leaks in the hollow turn-rail origin dot (now masked so the card shows through), anomaly filter bar, bridge notices, usage heatmap levels/month edges, and the `"Other"` consumption breakdown segment (`--cons-other-seg`).
  - Refined the multi-session overlay (`.wm-multi-panel`) to eliminate nested blur and stray hover sheen on flat task rows while improving frosted contrast for muted text.
- **Documentation**: Simplified bilingual README preview captions and corrected outlier TPS values in preview screenshots.

## [1.2.3] - 2026-11

### 更新内容
- **实时 TPS 120s 同模型短期沿用（`lastKnownTokPerSec`）**：
  - 新增 `findRecentStepTokPerSec`，当最新一步因缓冲突发或解码窗口过短（`held_burst` / `short_decode`）无法测出纯解码速度时，仅在 **同会话、同代理、同模型（同时校验 `responseModel` 与 `modelKey`）且时间间隔 ≤ 120s** 内沿用最近一次有效纯解码速率；切模型、缺时间戳或超时即清零。
  - `latestTokPerSec` 语义保持严格绑定最新一步，独立透出 `lastKnownTokPerSec` 供顶栏胶囊（悬浮标注「沿用最近有效」）、实时概览卡片、运行中任务列表与 CLI 状态栏使用，解决短工具调用后实时速度频繁闪成 `--` 的问题；明细表继续忠实显示 `—` 与排除原因，v7 纯解码中位数聚合口径不变。
  - 修正 CLI 状态栏在本地未解析到 `cascadeId` 时未校验 stdin 会话 ID 导致可能串读其他会话快照 TPS 的问题。
- **文档同步**：更新双语 README 副标题与 v1.2.2 特性说明，并在 `AGENTS.md` 中规范发行标题（严格使用 `vX.Y.Z`）与双语更新说明格式。

### English
- **120s Same-Model Live TPS Carry-Over (`lastKnownTokPerSec`)**:
  - Added `findRecentStepTokPerSec` to hold the most recent valid pure-decode rate when the newest step is unmeasurable (`held_burst` / `short_decode`), strictly scoped to the same conversation, agent, and model (checking both `responseModel` and `modelKey`) within a 120-second timestamp window; clears immediately on model change, missing timestamps, or timeout.
  - Kept `latestTokPerSec` strictly tied to the newest step and exposed `lastKnownTokPerSec` separately for the topbar capsule (with a `"Recent"` hover tooltip), Live Overview speed tile, running-sessions list, and CLI statusline — eliminating `--` flicker after short tool calls while leaving step-table `—` rows and v7 median aggregation untouched.
  - Fixed CLI statusline snapshot matching to validate stdin session IDs when local lookup has no `cascadeId`, preventing cross-session TPS bleed.
- **Documentation**: Synced bilingual README tagline & v1.2.2 features and documented release title (`vX.Y.Z`) and bilingual release-note conventions in `AGENTS.md`.

## [1.2.2] - 2026-11

### 更新内容
- **自适应相对缓冲突发过滤（Measurement v7）**：
  - 将 `MEASUREMENT_VERSION` 升至 `7` 并新增 `filterRelativeHeldBursts`，补筛解码窗口 `>= 1.0s` 但等待远大于解码（`ttft > 4 * decode`）且速率超过同会话同模型中位数 `3×`（至少 3 个基线样本）的漏网缓冲突发（如长等待纯工具调用），统一标记为 `held_burst` 排除，避免 1000+ `tok/s` 假高值污染均速。
- **用量趋势与首字耗时悬浮提示精简**：
  - 精简「用量趋势」（折线面积图与 >90 天热力图）悬浮卡片：移除冗余的每模型 4 段进度条与底部 4 通道网格，仅保留「时间区间 + 调用次数」「总 Token + 预估费用」及轻量单行「前 3 模型名 + 占比」明细；修复热力图 `周 / 月 / 全部` 聚合模式签名遗漏长尾模型变化的问题。
  - 移除明细表首字耗时拆解浮层中冗余的 `原生思考计时可能重叠首字或流式阶段，不可直接相加` 提示文案。
- **遗留冗余代码清理与轮询性能优化**：
  - 清理上游残留的 320 个死 CSS 类、321 对孤儿 i18n 词条（中英保持 514/514 对齐）、废弃的 30s 配额倒计时与 `minuteTick` 轮询重绘、旧版图表动画控制器、胶囊预览组件及未用 SVG 图标；修正偏好设置中残留的 `v1.4.4` 硬编码占位版本。编译产物 `styles.css` 缩小 27%（`282 KB → 206 KB`），`app.js` 缩小约 `60 KB`。
  - 移除后端年度 12 月桶聚合（`monthlySeries` / `monthlyYear`）、裁剪 `sourcesBreakdown` / `topConversations` / `topWorkspaces` 的未用嵌套 `models` 子数组（保留行级汇总供 XLSX / Markdown 导出）、停止预计算多余的 `5h` / `week` 预设并移除无效 `pool` 去重与空 `accountName` memo 传递。
  - 为常规轮询中的 CLI 状态探测与模型目录刷新增加缓存复用（含瞬时失败保留上一份有效模型目录、2s 短重试冷却、时钟回拨保护），并补齐 `consumption.revision` 比对以防历史回填后预取缓存陈旧。

### English
- **Adaptive Relative Held-Burst Filtering (Measurement v7)**:
  - Upgraded `MEASUREMENT_VERSION` to `7` with `filterRelativeHeldBursts` to catch long-wait buffered bursts whose decode window exceeds `1.0s` when `ttft > 4 * decode` and step TPS exceeds `3×` the same-model session median (with `>= 3` baseline samples), classifying them as `held_burst` so 1000+ `tok/s` tool-call spikes do not skew session speeds.
- **Streamlined Usage Trend & TTFT Tooltips**:
  - Simplified the Usage Trend hover tooltip (shared by curve and >90d heatmap views) by removing per-model 4-segment bars and the 4-channel micro-grid while retaining time + calls, hero tokens + cost, and concise single-line top-3 model share rows; fixed aggregate heatmap (`week`/`month`/`all`) render signatures to track full tail-model changes.
  - Removed the redundant `timingOverlapHint` disclaimer from the step TTFT timing breakdown popover.
- **Legacy Cleanup & Polling Hot-Path Optimization**:
  - Removed 320 obsolete CSS classes, 321 orphan i18n keys per locale (514/514 parity), the unused 30s quota countdown timer & `minuteTick` plumbing, dead chart controllers, capsule preview, 7 unused SVG icons, and hardcoded upstream `v1.4.4` version fallbacks in Preferences — shrinking `styles.css` by 27% (`282 KB → 206 KB`) and `app.js` by ~`60 KB`.
  - Removed the unused annual `monthlySeries` / `monthlyYear` accumulator, trimmed unused nested `models` arrays from `sourcesBreakdown` / `topConversations` / `topWorkspaces` (preserving row totals for XLSX / Markdown exports), stopped eagerly computing extra `5h` / `week` presets, and removed dead `pool` dedupe and empty `accountName` memo inputs.
  - Added 30s cached CLI status probing (with backward-clock expiration) and stale-while-revalidate model catalog caching (preserving the last good catalog across transient RPC failures with a 2s strict-caller retry cooldown), plus `consumption.revision` comparison in `isEquivalentTelemetry` so historical backfills invalidate prefetched ranges cleanly.

## [1.2.1] - 2026-11

### 更新内容
- **Magpie 口径实时 TPS 算法与中位数聚合（Measurement v6）**：
  - 参照 `yetone/magpie` 的解码测速规则将 `MEASUREMENT_VERSION` 升至 `6`：移除旧版 `50ms` 下限强行 clamp 及缺失 TTFT 时的总耗时回退，改为原生 TTFT 必需、最小解码窗口 `0.1s`、缓冲突发过滤（`decode < 1.0s && ttft > 4 * decode`）与 `10,000 tok/s` 物理上限过滤，消除服务端思考/工具调用攒包突发带来的数千 `tok/s` 假高值；采用整数纳秒比较消除浮点边界误判。
  - 会话均速、模型排行均速及导出报告由加权算术平均改为有效单步速度的**中位数**，并附带 2% 对数分桶 `rateBins` 支持前端多模型/多代理合并精确求中位数；补齐 `missing_ttft` / `short_decode` / `held_burst` / `speed_outlier` 双语排除标签。
  - 升级后选中会话家族立即按 v6 重算，非选中历史会话按批限流刷新，避免首屏卡顿。
- **Antigravity CLI / ACP（含 T3 Code）调用数据自动发现**：
  - 自动发现 `~/.gemini/antigravity-acp` 与 `~/.t3/userdata/providers/antigravity/*/{antigravity-acp,antigravity-cli}`（支持 `T3_USERDATA_DIR` 环境变量），动态刷新会话 SQLite、脑图日志、注释标题与 `daemon/` 端点目录。
  - 按会话 ID 合并多端 `conversation_summaries.db`（优先保留原生记录），将 ACP 路径正确归类为 CLI 来源，并修复部分库未就绪时的不完整快照误缓存问题。

### English
- **Magpie-Aligned Decode TPS & Median Aggregation (Measurement v6)**:
  - Upgraded `MEASUREMENT_VERSION` to `6` following `yetone/magpie`'s `DecodeWindow` / `DecodeOf` rules: removed the `50ms` floor clamp and missing-TTFT total-duration fallback, enforcing native TTFT presence, `>= 0.1s` decode window, held-burst rejection (`decode < 1.0s && ttft > 4 * decode`), and a `10,000 tok/s` cap using exact nanosecond integer comparisons to eliminate buffered-burst TPS spikes.
  - Switched session, model, and exported average speeds from weighted mean to **median** with compact 2% logarithmic histograms (`rateBins`) for accurate frontend multi-model/multi-agent merging, and added bilingual exclusion labels (`missing_ttft`, `short_decode`, `held_burst`, `speed_outlier`).
  - Refreshes the selected conversation family to v6 immediately on upgrade while throttling non-selected historical refreshes across polls.
- **Antigravity CLI / ACP (including T3 Code) Telemetry Discovery**:
  - Dynamically discovers `~/.gemini/antigravity-acp` and `~/.t3/userdata/providers/antigravity/*/{antigravity-acp,antigravity-cli}` (with `T3_USERDATA_DIR` override) for conversations, brain transcripts, annotations, and `daemon/` endpoints with a 5s TTL refresh.
  - Merges multi-root `conversation_summaries.db` snapshots by conversation ID (preferring native rows), classifies ACP sessions under CLI, and avoids memoizing partial summary snapshots when a database is temporarily unavailable.

## [1.2.0] - 2026-11

### English
- **Floating Window Mount Mode (`floating`: In-Page Floating Window + Sidebar)**:
  - Added a 4th panel mount mode (**Floating Window**) in Preferences alongside Dual, Composer, and Sidebar Only, allowing the full 3-tab monitor panel (including live recent-step cache & speed diagnostics) to stay pinned inside the page without repeated manual toggling.
  - Built an interactive floating window controller (`floatingPanelController.js`) with smooth titlebar dragging, zero-layout-shift edge/corner resizing (right, bottom, bottom-right), position & size lock/unlock, one-click reset to default geometry, and viewport-aware clamping with automatic sidebar clearance.
  - Added a collapsible **Floating Badge** mode (`.wm-floating-pill`): minimize the window into a compact draggable in-page pill showing live status dot, generation speed (`tok/s`), and context percentage, and click to expand back in place.
  - Persists floating window bounds, lock state, and minimized state across reloads (`agy-monitor.floating-panel.v1`), supports hot-switching between all 4 mount modes without restart, and adapts cleanly to both **Default** and **Liquid Glass** themes.
- **Vector Brand Logo & 5-Surface Identity Integration**:
  - Created a transparent-background vector brand logo ([`assets/logo.svg`](assets/logo.svg)) faithfully matching the original AGY Monitor icon geometry and gradient spectrum, sharp in both light and dark modes with zero PNG bloat in the runtime archive.
  - Registered `"logo": "assets/logo.svg"` in `plugin.json` and the release whitelist (`pack-release-zip.mjs`) so Antigravity's Plugins sidebar and manager display the custom icon automatically.
  - Integrated the vector logo (`createBrandIcon` with per-instance unique SVG gradient/mask IDs) across the floating window header bar, minimized floating badge, Standalone Web browser tab favicon (`index.html`), and Preferences version badge.

### 简体中文
- **新增「悬浮窗挂载」模式（`floating`：页内悬浮 + 侧边栏）**：
  - 在偏好设置挂载方式中新增第 4 项 **悬浮窗挂载 (页内悬浮 + 侧边栏)**，可将完整监控面板（含近期请求实时缓存、速度与调用明细）常驻钉在页面内，运行中无需反复手动点开查看。
  - 新增悬浮窗交互控制器（`floatingPanelController.js`）：支持顶栏拖拽移动、右侧/底部/右下角无占位缩放热区（切换锁定/解锁时内容零位移、左右留白对称）、一键锁定/解锁位置与尺寸、一键还原初始位置与尺寸，以及视口边界防溢出与侧边栏自动避让。
  - 支持 **一键收起为浮标**（`.wm-floating-pill`）：收起后化为可拖拽的页内迷你浮标，持续显示运行状态点、实时速度（`tok/s`）与上下文占比，点击即可原位展开；支持位置、尺寸、锁定与收起状态持久化，以及 4 种挂载模式热切换，完美适配 **默认** 与 **液态玻璃** 双主题。
- **透明矢量品牌图标（`assets/logo.svg`）与 5 处全界面接入**：
  - 按原版图标几何比例与色阶 1:1 矢量化制作透明背景 [`assets/logo.svg`](assets/logo.svg)，浅/深色主题下边缘锐利无白底，同时遵守运行时零 PNG 打包规范。
  - 在 `plugin.json` 注册 `"logo": "assets/logo.svg"` 并加入发布白名单，自动替换 Antigravity 侧边栏插件菜单与插件管理页的默认拼图图标。
  - 封装支持独立渐变/遮罩 ID 的 `createBrandIcon()`，同步接入悬浮窗顶栏标题前、最小化悬浮浮标、独立 Web 面板浏览器标签页 Favicon（`index.html`）以及偏好设置版本号前。

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
