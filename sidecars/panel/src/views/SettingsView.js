/**
 * @fileoverview View 3: Streamlined Preferences (single-page layout).
 * Consolidates essential appearance, display, mount, and maintenance controls
 * without account/quota management clutter.
 */

import { defineComponent } from '../core/component.js';
import {
  normalizeClientFontScale,
  normalizeClientThemeAccent,
  normalizeClientUiTheme,
} from '../core/appearance.js';
import { h, patchAttr, patchClasses, patchText } from '../core/domPatch.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { i18nStore, normalizeI18nLanguage, setI18nLanguage, t } from '../i18n/index.js';
import {
  normalizeClientModelDisplayMode,
  normalizeClientWindowMountMode,
  rebuildTrajectoryCache,
  resetAllSettings,
  saveSettingsPatch,
  telemetryStore,
  triggerCloudSync,
  triggerPluginUpdate,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import { ThemeColorPicker } from '../components/settings/ThemeColorPicker.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

export const SHOW_ACCOUNT_TAB = false;

function getLanguageOptions() {
  return [
    { value: 'auto', label: t('settings.gen.langAuto') },
    { value: 'zh-CN', label: t('settings.gen.langZh') },
    { value: 'en-US', label: t('settings.gen.langEn') },
  ];
}

function getUiThemeOptions() {
  return [
    { value: 'default', label: t('settings.gen.uiThemeDefault') },
    { value: 'liquid_glass', label: t('settings.gen.uiThemeLiquidGlass') },
  ];
}

function getFontScaleOptions() {
  return [
    { value: 'sm', label: t('settings.gen.fontSm') },
    { value: 'md', label: t('settings.gen.fontMd') },
    { value: 'lg', label: t('settings.gen.fontLg') },
    { value: 'xl', label: t('settings.gen.fontXl') },
  ];
}

function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

function getMountModeOptions() {
  return [
    { value: 'dual', label: t('settings.str.mountDual') },
    { value: 'composer', label: t('settings.str.mountComposer') },
    { value: 'sidebar', label: t('settings.str.mountSidebar') },
  ];
}

export const SettingsView = defineComponent({
  name: 'SettingsView',
  setup({ onCleanup }) {
    let viewScrollbar = null;
    const refreshScroll = () => {
      if (viewScrollbar) {
        viewScrollbar.refresh();
      }
    };

    // --- 常规精简页状态与回调 ---
    let draftLanguage = 'auto';
    let draftUiTheme = 'default';
    let draftThemeAccent = 'host';
    let draftFontScale = 'md';
    let draftModelDisplayMode = 'short';
    let draftWindowMountMode = 'dual';
    let latestSettings = null;
    let latestCloudStatus = null;
    let displayTimer = null;
    let displaySaveSeq = 0;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const displayStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted settings-panel-status',
      text: '',
    });

    function showDisplayFeedback(text, autoClearMs = 1500) {
      if (displayTimer) {
        clearTimeout(displayTimer);
        displayTimer = null;
      }
      patchText(displayStatusText, text);
      if (text && autoClearMs > 0) {
        displayTimer = setTimeout(() => {
          displayTimer = null;
          patchText(displayStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      patchAttr(maintStatusText, 'title', text || null);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
          patchAttr(maintStatusText, 'title', null);
        }, autoClearMs);
      }
    }

    async function persistQuickPatch(patchObj) {
      const token = ++displaySaveSeq;
      showDisplayFeedback(t('settings.saving'), 0);
      try {
        await saveSettingsPatch(patchObj);
        if (token === displaySaveSeq) {
          showDisplayFeedback(t('settings.saved'), 1500);
        }
      } catch {
        if (latestSettings) renderGeneralSettings(latestSettings);
        if (token === displaySaveSeq) {
          showDisplayFeedback(t('settings.saveFailed'), 2500);
        }
      }
    }

    // Card 1: 外观与显示 (语言、界面风格、主题色、字号、模型名显示、挂载位置)
    const appearanceTitleEl = h('span', { text: t('settings.simple.appearanceTitle') });
    const langLabelEl = h('span', { className: 'form-label', text: t('settings.gen.language') });
    const uiThemeLabelEl = h('span', { className: 'form-label', text: t('settings.gen.uiTheme') });
    const accentLabelEl = h('span', { className: 'form-label', text: t('settings.gen.themeAccent') });
    const fontLabelEl = h('span', { className: 'form-label', text: t('settings.gen.fontScale') });
    const modelFormatLabelEl = h('span', { className: 'form-label', text: t('settings.oth.modelFormat') });
    const mountModeLabelEl = h('span', { className: 'form-label', text: t('settings.str.mountMode') });

    const languageSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.language'),
      modelValue: draftLanguage,
      options: getLanguageOptions(),
      onUpdateModelValue: (val) => {
        const nextLang = normalizeI18nLanguage(val);
        draftLanguage = nextLang;
        setI18nLanguage(nextLang);
        languageSwitch.setValue(nextLang);
        void persistQuickPatch({ language: nextLang });
      },
    });

    const uiThemeSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.uiTheme'),
      modelValue: draftUiTheme,
      options: getUiThemeOptions(),
      onUpdateModelValue: (val) => {
        const nextTheme = normalizeClientUiTheme(val);
        draftUiTheme = nextTheme;
        uiThemeSwitch.setValue(nextTheme);
        refreshScroll();
        void persistQuickPatch({ uiTheme: nextTheme });
      },
    });

    const themeColorPicker = ThemeColorPicker({
      modelValue: draftThemeAccent,
      onUpdateModelValue: (val) => {
        const nextAccent = normalizeClientThemeAccent(val);
        draftThemeAccent = nextAccent;
        themeColorPicker.refs.setValue(nextAccent);
        void persistQuickPatch({ themeAccent: nextAccent });
      },
    });

    const fontScaleSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.fontScale'),
      modelValue: draftFontScale,
      options: getFontScaleOptions(),
      onUpdateModelValue: (val) => {
        const nextScale = normalizeClientFontScale(val);
        draftFontScale = nextScale;
        fontScaleSwitch.setValue(nextScale);
        refreshScroll();
        void persistQuickPatch({ fontScale: nextScale });
      },
    });

    const stepModelSelect = CustomSelect({
      modelValue: draftModelDisplayMode,
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        void persistQuickPatch({
          modelDisplayMode: nextMode,
          showUpstreamModel: nextMode !== 'short',
        });
      },
    });

    const windowMountSelect = CustomSelect({
      modelValue: draftWindowMountMode,
      icon: 'dock',
      options: getMountModeOptions(),
      onUpdateModelValue: (val) => {
        const nextMode = normalizeClientWindowMountMode(val);
        draftWindowMountMode = nextMode;
        windowMountSelect.setValue(nextMode);
        refreshScroll();
        void persistQuickPatch({
          windowMountMode: nextMode,
          enableWindowOverlay: nextMode !== 'sidebar',
        });
      },
    });

    const appearancePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          appearanceTitleEl,
        ]),
        displayStatusText,
      ]),
      h('div', { className: 'form-row' }, [langLabelEl, languageSwitch.el]),
      h('div', { className: 'form-row' }, [uiThemeLabelEl, uiThemeSwitch.el]),
      h('div', { className: 'form-row' }, [accentLabelEl, themeColorPicker.el]),
      h('div', { className: 'form-row' }, [fontLabelEl, fontScaleSwitch.el]),
      h('div', { className: 'form-row' }, [modelFormatLabelEl, stepModelSelect.el]),
      h('div', { className: 'form-row' }, [mountModeLabelEl, windowMountSelect.el]),
    ]);

    // Card 2: 数据与维护 (版本与价格同步 + 重建缓存 / 恢复默认)
    const maintTitleEl = h('span', { text: t('settings.simple.maintTitle') });
    const versionRowLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.simple.versionRow'),
    });
    const versionTagEl = h('span', { className: 'text-mono text-secondary', text: 'v1.4.4' });

    const syncPricingBtnText = h('span', { text: t('settings.gen.syncBtn') });
    const syncPricingBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(syncPricingBtn, 'disabled', true);
          patchText(syncPricingBtnText, t('settings.gen.syncingBtn'));
          showMaintFeedback(t('settings.gen.syncingMsg'), 0);
          try {
            const res = await triggerCloudSync();
            const cs = res?.cloudStatus;
            if (res?.ok && cs) {
              showMaintFeedback(t('settings.gen.syncedMsg', { count: cs.modelCount }), 3200);
            } else {
              showMaintFeedback(cs?.lastSyncError || t('settings.gen.syncFallbackMsg'), 4000);
            }
          } catch (err) {
            showMaintFeedback(err?.message || t('settings.gen.syncFallbackMsg'), 4000);
          } finally {
            patchAttr(syncPricingBtn, 'disabled', false);
            patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncPricingBtnText]
    );

    const updatePluginBtnText = h('span', { text: t('settings.gen.checkUpdateBtn') });
    const updatePluginBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(updatePluginBtn, 'disabled', true);
          try {
            if (!latestCloudStatus?.updateAvailable) {
              patchText(updatePluginBtnText, t('settings.gen.checkingBtn'));
              showMaintFeedback(t('settings.gen.checkingMsg'), 0);
              const syncRes = await triggerCloudSync();
              const cs = syncRes?.cloudStatus || latestCloudStatus;
              if (cs) {
                latestCloudStatus = cs;
                renderCloudStatus(cs);
              }
              if (!syncRes?.ok && cs?.lastSyncError) {
                showMaintFeedback(t('settings.gen.checkFailedMsg', { err: cs.lastSyncError }), 4500);
                return;
              }
              if (!cs?.updateAvailable) {
                const curVer = cs?.currentPluginVersion || '1.4.4';
                showMaintFeedback(t('settings.gen.upToDateMsg', { ver: curVer }), 4000);
                return;
              }
            }
            patchText(updatePluginBtnText, t('capsule.updating'));
            showMaintFeedback(t('settings.gen.downloadingMsg'), 0);
            const res = await triggerPluginUpdate();
            if (res?.cloudStatus) {
              latestCloudStatus = res.cloudStatus;
            }
            if (res?.ok) {
              showMaintFeedback(res.message || t('settings.gen.updatedRestartMsg'), 4500);
            } else {
              showMaintFeedback(res?.message || t('settings.gen.updateSkippedMsg'), 4500);
            }
          } catch (err) {
            showMaintFeedback(err?.message || t('settings.gen.updateFailedMsg'), 4500);
          } finally {
            patchAttr(updatePluginBtn, 'disabled', false);
            renderCloudStatus(latestCloudStatus);
          }
        },
      },
      [createSvgIcon('arrow-down', { size: 12 }), updatePluginBtnText]
    );

    const cacheLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.cacheLabel'),
    });
    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            showMaintFeedback(
              res?.ok !== false ? t('settings.oth.rebuildDone') : t('settings.oth.rebuildFailed'),
              2800
            );
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });
    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }
          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'auto');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header settings-panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('bolt', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'form-row' }, [
        versionRowLabelEl,
        h('div', { className: 'settings-compact-actions' }, [
          versionTagEl,
          syncPricingBtn,
          updatePluginBtn,
        ]),
      ]),
      h('div', { className: 'form-row' }, [
        cacheLabelEl,
        h('div', { className: 'settings-compact-actions' }, [
          rebuildCacheBtn,
          resetAllBtn,
        ]),
      ]),
    ]);

    const generalPane = h('div', { className: 'settings-tab-stack' }, [
      appearancePanel,
      maintPanel,
    ]);

    function renderGeneralSettings(settings) {
      if (!settings) return;
      latestSettings = settings;
      draftLanguage = normalizeI18nLanguage(settings.language);
      draftUiTheme = normalizeClientUiTheme(settings.uiTheme);
      draftThemeAccent = normalizeClientThemeAccent(settings.themeAccent);
      draftFontScale = normalizeClientFontScale(settings.fontScale);
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftWindowMountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );

      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      uiThemeSwitch.setProps({
        modelValue: draftUiTheme,
        options: getUiThemeOptions(),
      });
      themeColorPicker.refs.setValue(draftThemeAccent);
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      windowMountSelect.setProps({
        modelValue: draftWindowMountMode,
        options: getMountModeOptions(),
      });
    }

    function renderCloudStatus(cs) {
      if (!cs) return;
      latestCloudStatus = cs;
      const curVer = cs.currentPluginVersion || '1.4.4';
      const latVer = cs.latestPluginVersion || curVer;
      patchText(versionTagEl, `v${curVer}`);
      if (cs.updateAvailable) {
        patchText(updatePluginBtnText, t('settings.gen.upgradeToBtn', { ver: latVer }));
        patchClasses(updatePluginBtn, { 'btn-primary': true, 'btn-secondary': false });
      } else {
        patchText(updatePluginBtnText, t('settings.gen.checkUpdateBtn'));
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      }
    }

    function refreshGeneralLabels() {
      patchText(appearanceTitleEl, t('settings.simple.appearanceTitle'));
      patchText(langLabelEl, t('settings.gen.language'));
      patchText(uiThemeLabelEl, t('settings.gen.uiTheme'));
      patchText(accentLabelEl, t('settings.gen.themeAccent'));
      patchText(fontLabelEl, t('settings.gen.fontScale'));
      patchText(modelFormatLabelEl, t('settings.oth.modelFormat'));
      patchText(mountModeLabelEl, t('settings.str.mountMode'));
      patchText(maintTitleEl, t('settings.simple.maintTitle'));
      patchText(versionRowLabelEl, t('settings.simple.versionRow'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      if (!syncPricingBtn.hasAttribute('disabled')) {
        patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
      }
      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }
      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      uiThemeSwitch.setProps({
        modelValue: draftUiTheme,
        options: getUiThemeOptions(),
      });
      themeColorPicker.refs.refreshLabels();
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      windowMountSelect.setProps({
        modelValue: draftWindowMountMode,
        options: getMountModeOptions(),
      });
      if (latestCloudStatus) {
        renderCloudStatus(latestCloudStatus);
      }
    }

    viewScrollbar = CustomScrollbar({
      contentEl: generalPane,
      className: 'view-pane',
    });

    const rootEl = h('div', { className: 'settings-view-root' }, [viewScrollbar.el]);

    function syncActiveTab() {
      const ui = uiStore.getState();
      if (getVisibleMonitorView(ui) !== 'settings') return;
      const telemetry = telemetryStore.getState().telemetry;
      if (telemetry?.settings) renderGeneralSettings(telemetry.settings);
      if (telemetry?.cloudStatus) renderCloudStatus(telemetry.cloudStatus);
      refreshScroll();
    }

    syncActiveTab();

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        settings: st.telemetry?.settings,
        cloudStatus: st.telemetry?.cloudStatus,
      }),
      syncActiveTab
    );

    const unsubUi = uiStore.subscribe(
      (st) => getVisibleMonitorView(st),
      syncActiveTab
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        refreshGeneralLabels();
        refreshScroll();
      }
    );

    onCleanup(() => {
      if (displayTimer) clearTimeout(displayTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      unsubTelemetry();
      unsubUi();
      unsubI18n();
      languageSwitch.destroy();
      uiThemeSwitch.destroy();
      themeColorPicker.destroy();
      fontScaleSwitch.destroy();
      stepModelSelect.destroy();
      windowMountSelect.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        viewScrollbar,
        languageSwitch,
        uiThemeSwitch,
        themeColorPicker,
        fontScaleSwitch,
        stepModelSelect,
        windowMountSelect,
        syncPricingBtn,
        updatePluginBtn,
        rebuildCacheBtn,
        resetAllBtn,
      },
    };
  },
});
