// Settings › Terminal › Behavior: scrollback, cursor, mouse and keyboard
// options applied to every terminal (terminal-settings.ts, context-menu.ts,
// terminal-mouse.ts).

import type { AppSettings } from './themes';
import { t } from './i18n';
import { isMacPlatform } from './app-state';
import { createSettingsSelect } from './custom-select';
import { switchRow } from './settings-command-assist';

const SCROLLBACK_CHOICES = [1000, 5000, 10_000, 50_000, 100_000];

function selectRow(label: string, options: { value: string; label: string }[], value: string,
  onChange: (value: string) => void, hint?: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'settings-section';
  const name = document.createElement('label');
  name.textContent = label;
  if (hint) {
    const small = document.createElement('small');
    small.className = 'settings-row-hint';
    small.textContent = hint;
    name.appendChild(small);
  }
  const select = createSettingsSelect(options.map((o) => ({ ...o, selected: o.value === value })));
  select.onchange = () => onChange(select.value);
  section.append(name, select.el);
  return section;
}

export function createTerminalInputRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  const scrollback = String(current.terminalScrollback ?? 5000);
  const scrollbackOptions = SCROLLBACK_CHOICES.map((n) => ({ value: String(n), label: n.toLocaleString() }));
  if (!scrollbackOptions.some((o) => o.value === scrollback)) {
    scrollbackOptions.push({ value: scrollback, label: Number(scrollback).toLocaleString() });
  }
  const rows: HTMLElement[] = [
    selectRow(t('terminalScrollback'), scrollbackOptions, scrollback,
      (v) => update({ terminalScrollback: Number(v) }), t('terminalScrollbackHint')),
    selectRow(t('terminalCursorStyle'), [
      { value: 'block', label: t('terminalCursorBlock') },
      { value: 'bar', label: t('terminalCursorBar') },
      { value: 'underline', label: t('terminalCursorUnderline') },
    ], current.terminalCursorStyle ?? 'block',
    (v) => update({ terminalCursorStyle: v as AppSettings['terminalCursorStyle'] })),
    switchRow('terminal-cursor-blink', t('terminalCursorBlink'), current.terminalCursorBlink ?? true,
      (on) => update({ terminalCursorBlink: on })),
    switchRow('terminal-copy-on-select', t('copyOnSelect'), !!current.copyOnSelect,
      (on) => update({ copyOnSelect: on }), t('copyOnSelectHint')),
    selectRow(t('terminalRightClick'), [
      { value: 'menu', label: t('terminalRightClickMenu') },
      { value: 'paste', label: t('terminalRightClickPaste') },
    ], current.terminalRightClick ?? 'menu',
    (v) => update({ terminalRightClick: v as AppSettings['terminalRightClick'] }), t('terminalRightClickHint')),
  ];
  if (isMacPlatform) {
    rows.push(switchRow('mac-option-meta', t('macOptionIsMeta'), !!current.macOptionIsMeta,
      (on) => update({ macOptionIsMeta: on }), t('macOptionIsMetaHint')));
  }
  return rows;
}
