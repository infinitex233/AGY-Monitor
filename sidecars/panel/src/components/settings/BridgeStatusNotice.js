/**
 * @fileoverview Shared CDP / Window Bridge diagnostic & one-click relaunch card (`BridgeStatusNotice.js`).
 * Surfaces automatic shortcut provisioning status and a one-click host relaunch button when
 * Antigravity 2.33.0+ runs without an active `DevToolsActivePort` (`no_devtools_port` / `cdp_unreachable`).
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { isWindowOverlayMode } from '../../core/httpClient.js';
import {
  copyPlainTextToClipboard,
  createCopiedFeedbackController,
} from '../../core/stepInspector.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { triggerBridgeHostRelaunch } from '../../store/telemetryStore.js';

const LAUNCH_FLAG_TEXT = '--remote-debugging-port=0';

export const BridgeStatusNotice = defineComponent({
  name: 'BridgeStatusNotice',
  setup({ props, onCleanup }) {
    const dismissible = Boolean(props?.dismissible);
    let lastPayload = {
      visible: false,
      windowBridge: null,
      hostPlatform: 'win32',
    };
    let dismissed = false;
    let relaunchState = 'idle'; // 'idle' | 'relaunching' | 'failed'
    let relaunchResetTimer = null;
    let destroyed = false;
    const copyFeedback = createCopiedFeedbackController({
      durationMs: 1800,
      onCleanup,
      onChange: () => {
        if (!destroyed) syncActionButtons();
      },
    });

    const headIconEl = createSvgIcon('warning', { size: 13, className: 'settings-bridge-icon' });
    const titleEl = h('strong', { className: 'settings-bridge-title', text: '' });
    const bodyEl = h('p', { className: 'settings-bridge-desc', text: '' });

    const dismissBtnEl = dismissible
      ? h(
          'button',
          {
            type: 'button',
            className: 'btn-ghost-sm settings-bridge-dismiss-btn',
            'aria-label': t('settings.bridge.dismissAria'),
            title: t('settings.bridge.dismissAria'),
            onClick: () => {
              dismissed = true;
              render();
              props?.onDismiss?.();
            },
          },
          [createSvgIcon('close', { size: 11 })]
        )
      : null;

    const relaunchBtnIconEl = createSvgIcon('refresh', { size: 11 });
    const relaunchBtnTextEl = h('span', {
      className: 'settings-bridge-relaunch-text',
      text: t('settings.bridge.relaunchBtn'),
    });
    const relaunchBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'settings-bridge-relaunch-btn',
        onClick: async () => {
          if (relaunchState === 'relaunching' || destroyed) return;
          relaunchState = 'relaunching';
          if (relaunchResetTimer) {
            clearTimeout(relaunchResetTimer);
            relaunchResetTimer = null;
          }
          syncActionButtons();
          try {
            const res = await triggerBridgeHostRelaunch();
            if (destroyed) return;
            if (!res || res.ok === false) {
              relaunchState = 'failed';
              syncActionButtons();
              relaunchResetTimer = setTimeout(() => {
                relaunchResetTimer = null;
                if (destroyed) return;
                relaunchState = 'idle';
                syncActionButtons();
              }, 3500);
              relaunchResetTimer?.unref?.();
              return;
            }
            // Reset button if host is still open after 9s (e.g. cancelled close prompt)
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 9000);
            relaunchResetTimer?.unref?.();
          } catch {
            if (destroyed) return;
            relaunchState = 'failed';
            syncActionButtons();
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 3500);
            relaunchResetTimer?.unref?.();
          }
        },
      },
      [relaunchBtnIconEl, relaunchBtnTextEl]
    );

    const copyBtnIconEl = createSvgIcon('copy', { size: 11 });
    const copyBtnTextEl = h('span', {
      className: 'settings-bridge-copy-text',
      text: t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT }),
    });
    const copyBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm settings-bridge-copy-btn',
        onClick: async () => {
          await copyPlainTextToClipboard(LAUNCH_FLAG_TEXT);
          if (destroyed) return;
          copyFeedback.trigger(true);
        },
      },
      [copyBtnIconEl, copyBtnTextEl]
    );

    const headLeftEl = h('div', { className: 'settings-bridge-head-main' }, [headIconEl, titleEl]);
    const headRowEl = h(
      'div',
      { className: 'settings-bridge-head' },
      dismissBtnEl ? [headLeftEl, dismissBtnEl] : [headLeftEl]
    );
    const actionsRowEl = h('div', { className: 'settings-bridge-actions' }, [
      relaunchBtnEl,
      copyBtnEl,
    ]);

    const rootEl = h(
      'div',
      {
        className: 'settings-bridge-notice',
        role: 'status',
        hidden: true,
      },
      [headRowEl, bodyEl, actionsRowEl]
    );

    function syncActionButtons() {
      const canRelaunch = lastPayload.windowBridge?.canRelaunch !== false;
      const needsAuth = Boolean(lastPayload.windowBridge?.hasReadOnlyShortcuts);
      patchAttr(relaunchBtnEl, 'hidden', !canRelaunch);
      patchAttr(relaunchBtnEl, 'disabled', relaunchState === 'relaunching');
      patchText(
        relaunchBtnTextEl,
        relaunchState === 'relaunching'
          ? t('settings.bridge.relaunchingBtn')
          : relaunchState === 'failed'
            ? t('settings.bridge.relaunchFailed')
            : needsAuth
              ? t('settings.bridge.relaunchAuthBtn')
              : t('settings.bridge.relaunchBtn')
      );

      const isCopied = copyFeedback.isCopied(true);
      patchSvgIcon(copyBtnIconEl, isCopied ? 'check' : 'copy');
      patchText(
        copyBtnTextEl,
        isCopied
          ? t('settings.bridge.copiedBtn')
          : t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT })
      );

      if (dismissBtnEl) {
        const aria = t('settings.bridge.dismissAria');
        patchAttr(dismissBtnEl, 'aria-label', aria);
        patchAttr(dismissBtnEl, 'title', aria);
      }
    }

    function render() {
      const wb = lastPayload.windowBridge;
      const state = String(wb?.state || '').trim();
      if (state === 'active') {
        dismissed = false;
      }
      const shouldShow =
        !dismissed &&
        Boolean(lastPayload.visible) &&
        !isWindowOverlayMode() &&
        (state === 'no_devtools_port' || state === 'cdp_unreachable');

      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const plat = String(lastPayload.hostPlatform || '').trim().toLowerCase();
      const hasReadOnlyShortcuts = Boolean(wb?.hasReadOnlyShortcuts);
      const isMacDesktop = plat === 'darwin' && !wb?.argvConfigured;
      const isAutoConfigured = Boolean(
        wb?.launcherConfigured || wb?.argvUpdatedThisBoot || wb?.argvConfigured
      );
      const useRestartTheme = !hasReadOnlyShortcuts && (isAutoConfigured || isMacDesktop);

      patchClasses(rootEl, {
        'is-restart': useRestartTheme,
        'is-warn': !useRestartTheme,
      });
      patchSvgIcon(headIconEl, useRestartTheme ? 'refresh' : 'warning');

      let titleText = '';
      let bodyText = '';
      if (hasReadOnlyShortcuts) {
        titleText = t('settings.bridge.readOnlyTitle');
        bodyText = t('settings.bridge.readOnlyBody');
      } else if (isMacDesktop) {
        titleText = t('settings.bridge.macTitle');
        bodyText = t('settings.bridge.guideMac');
      } else if (isAutoConfigured) {
        titleText = t('settings.bridge.restartTitle');
        bodyText = t('settings.bridge.restartBody');
      } else {
        titleText = state === 'cdp_unreachable'
          ? t('settings.bridge.unreachableTitle')
          : t('settings.bridge.noPortTitle');
        bodyText = plat === 'linux' ? t('settings.bridge.guideLinux') : t('settings.bridge.guideWin');
      }

      patchText(titleEl, titleText);
      patchText(bodyEl, bodyText);
      syncActionButtons();
    }

    function update(next = {}) {
      lastPayload = {
        ...lastPayload,
        ...next,
      };
      render();
    }

    onCleanup(() => {
      destroyed = true;
      if (relaunchResetTimer) {
        clearTimeout(relaunchResetTimer);
        relaunchResetTimer = null;
      }
    });

    return {
      el: rootEl,
      refs: {
        update,
        refreshLabels: render,
        relaunchBtnEl,
        copyBtnEl,
        dismissBtnEl,
      },
    };
  },
});
