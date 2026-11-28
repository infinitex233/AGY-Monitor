/**
 * @fileoverview Shared compact search input bar (`SearchInput.js`) with leading search icon
 * and conditional clear button, reused in `CustomSelect` and `StepsDetailView`.
 */

import { h, patchAttr } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';

/**
 * Creates a unified search input box while preserving caller-specific modifier classes.
 *
 * @param {{
 *   wrapClassName?: string,
 *   iconClassName?: string,
 *   inputClassName?: string,
 *   clearClassName?: string,
 *   placeholder?: string,
 *   ariaLabel?: string,
 *   clearAriaLabel?: string,
 *   hidden?: boolean,
 *   stopClickPropagation?: boolean,
 *   closeIconSize?: number,
 *   onInput?: (value: string, event: any) => void,
 *   onClear?: (event: any) => void,
 *   onKeydown?: (event: any) => void,
 * }} [options={}]
 */
export function createSearchInput({
  wrapClassName = '',
  iconClassName = '',
  inputClassName = '',
  clearClassName = '',
  placeholder = '',
  ariaLabel = '',
  clearAriaLabel = '',
  hidden = false,
  stopClickPropagation = false,
  closeIconSize = 10,
  onInput = null,
  onClear = null,
  onKeydown = null,
} = {}) {
  const iconEl = createSvgIcon('search', {
    size: 12,
    className: ['ui-search-icon', iconClassName].filter(Boolean).join(' '),
  });

  const inputEl = h('input', {
    type: 'text',
    className: ['ui-search-input', inputClassName].filter(Boolean).join(' '),
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder,
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ...(stopClickPropagation ? { onClick: (e) => e.stopPropagation?.() } : {}),
    onInput: (e) => {
      const val = String(e?.target?.value ?? inputEl.value ?? '');
      patchAttr(clearBtnEl, 'hidden', !val.trim());
      onInput?.(val, e);
    },
    ...(onKeydown ? { onKeydown } : {}),
  });

  const clearBtnEl = h(
    'button',
    {
      type: 'button',
      className: ['ui-search-clear', clearClassName].filter(Boolean).join(' '),
      hidden: true,
      ...(clearAriaLabel ? { 'aria-label': clearAriaLabel } : {}),
      onClick: (e) => {
        if (stopClickPropagation) e?.stopPropagation?.();
        inputEl.value = '';
        patchAttr(clearBtnEl, 'hidden', true);
        if (onClear) {
          onClear(e);
        } else {
          onInput?.('', e);
          inputEl.focus?.();
        }
      },
    },
    [createSvgIcon('close', { size: closeIconSize })]
  );

  const wrapEl = h(
    'div',
    {
      className: ['ui-search-wrap', wrapClassName].filter(Boolean).join(' '),
      ...(hidden ? { hidden: true } : {}),
      ...(stopClickPropagation ? { onClick: (e) => e.stopPropagation?.() } : {}),
    },
    [iconEl, inputEl, clearBtnEl]
  );

  return {
    el: wrapEl,
    iconEl,
    inputEl,
    clearBtnEl,
    getValue() {
      return String(inputEl.value || '');
    },
    setValue(nextVal) {
      const str = String(nextVal ?? '');
      inputEl.value = str;
      patchAttr(clearBtnEl, 'hidden', !str.trim());
    },
    syncLabels({ placeholder: nextPlaceholder, ariaLabel: nextAria, clearAriaLabel: nextClearAria } = {}) {
      if (nextPlaceholder !== undefined) patchAttr(inputEl, 'placeholder', nextPlaceholder);
      if (nextAria !== undefined) patchAttr(inputEl, 'aria-label', nextAria);
      if (nextClearAria !== undefined) patchAttr(clearBtnEl, 'aria-label', nextClearAria);
    },
    focus() {
      inputEl.focus?.();
    },
  };
}
