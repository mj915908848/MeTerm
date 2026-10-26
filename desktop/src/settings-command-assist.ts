// Settings › Terminal › Command Assist: tldr help, inline command
// completion and SSH shell-hook injection. None of these need an AI
// provider, so they live with the terminal settings.

import { AppSettings } from './themes';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';

type TldrStatus = { initialized: boolean; page_count: number; last_updated: number | null };

export function switchRow(id: string, text: string, checked: boolean, onChange: (on: boolean) => void, hint?: string): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'settings-switch-row';
  const span = document.createElement('span');
  span.className = 'settings-switch-text';
  span.textContent = text;
  if (hint) {
    const small = document.createElement('small');
    small.className = 'settings-row-hint';
    small.textContent = hint;
    span.appendChild(small);
  }
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  row.append(span, input);
  return row;
}

export function createCommandAssistRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  const tldrRow = switchRow('tldr-enable', t('tldrEnable'), current.tldrEnabled,
    (on) => update({ tldrEnabled: on }));

  // Help data: page count on the left, update button on the right.
  const dataRow = document.createElement('div');
  dataRow.className = 'settings-section';
  const tldrStatus = document.createElement('label');
  tldrStatus.className = 'settings-test-result';
  const tldrUpdateBtn = document.createElement('button');
  tldrUpdateBtn.className = 'settings-select settings-test-btn';
  tldrUpdateBtn.style.justifySelf = 'end';
  tldrUpdateBtn.textContent = t('tldrUpdateNow');
  dataRow.append(tldrStatus, tldrUpdateBtn);

  const showStatus = (status: TldrStatus) => {
    const ready = status.initialized && status.page_count > 0;
    tldrStatus.textContent = ready ? t('tldrPageCount').replace('{count}', String(status.page_count)) : t('tldrNoData');
    tldrStatus.className = 'settings-test-result' + (ready ? ' test-success' : '');
  };
  tldrUpdateBtn.addEventListener('click', async () => {
    tldrUpdateBtn.disabled = true;
    tldrStatus.textContent = t('tldrUpdating');
    tldrStatus.className = 'settings-test-result';
    try {
      showStatus(await invoke<TldrStatus>('tldr_init', { language: 'en', forceUpdate: true }));
    } catch (e) {
      tldrStatus.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      tldrStatus.className = 'settings-test-result test-failed';
    }
    tldrUpdateBtn.disabled = false;
  });
  invoke<TldrStatus>('tldr_status').then(showStatus).catch(() => { /* ignore */ });

  const completionRow = switchRow('cmd-completion-enable', t('cmdCompletionEnable'), current.cmdCompletionEnabled,
    (on) => update({ cmdCompletionEnabled: on }),
    t('cmdCompletionHint'));

  const hookRow = switchRow('shell-hook-enable', t('shellHookEnable'), current.shellHookInjection,
    (on) => update({ shellHookInjection: on }), t('shellHookHint'));

  return [tldrRow, dataRow, completionRow, hookRow];
}
