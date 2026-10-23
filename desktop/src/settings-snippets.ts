// Settings › Terminal › Snippets: the commands the snippet palette
// (Cmd/Ctrl+Shift+S, snippets.ts) sends to the terminal.

import type { AppSettings, CommandSnippet } from './themes';
import { t } from './i18n';
import { isMacPlatform } from './app-state';

function newSnippetId(): string {
  return `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createSnippetRows(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLElement[] {
  let snippets: CommandSnippet[] = (current.commandSnippets ?? []).map((s) => ({ ...s }));
  const save = () => update({ commandSnippets: snippets.map((s) => ({ ...s })) });

  const container = document.createElement('div');
  container.className = 'snippet-settings';

  function editor(snippet: CommandSnippet | null): HTMLElement {
    const form = document.createElement('div');
    form.className = 'snippet-editor';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'settings-input snippet-editor-name';
    name.placeholder = t('snippetNamePlaceholder');
    name.value = snippet?.name ?? '';

    const command = document.createElement('textarea');
    command.className = 'settings-input snippet-editor-command';
    command.placeholder = t('snippetCommandPlaceholder');
    command.rows = 3;
    command.spellcheck = false;
    command.value = snippet?.command ?? '';

    const runLabel = document.createElement('label');
    runLabel.className = 'snippet-editor-run';
    const run = document.createElement('input');
    run.type = 'checkbox';
    run.checked = snippet?.run ?? true;
    runLabel.append(run, document.createTextNode(` ${t('snippetRunOnSend')}`));

    const actions = document.createElement('div');
    actions.className = 'snippet-editor-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'settings-select settings-test-btn';
    cancel.textContent = t('snippetCancel');
    cancel.onclick = render;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'settings-select settings-test-btn snippet-editor-save';
    ok.textContent = t('snippetSave');
    const sync = () => { ok.disabled = !command.value.trim(); };
    command.addEventListener('input', sync);
    sync();
    ok.onclick = () => {
      const value: CommandSnippet = {
        id: snippet?.id ?? newSnippetId(),
        name: name.value.trim(),
        command: command.value.replace(/\s+$/, ''),
        run: run.checked,
      };
      if (!value.command) return;
      const i = snippets.findIndex((s) => s.id === value.id);
      if (i >= 0) snippets[i] = value; else snippets.push(value);
      save();
      render();
    };
    actions.append(runLabel, cancel, ok);

    form.append(name, command, actions);
    setTimeout(() => (snippet ? command : name).focus(), 0);
    return form;
  }

  function render(): void {
    container.innerHTML = '';
    const intro = document.createElement('div');
    intro.className = 'snippet-settings-intro';
    intro.textContent = t(isMacPlatform ? 'snippetSettingsHintMac' : 'snippetSettingsHint');
    container.appendChild(intro);

    snippets.forEach((snippet, index) => {
      const row = document.createElement('div');
      row.className = 'snippet-settings-item';
      const text = document.createElement('div');
      text.className = 'snippet-settings-text';
      const title = document.createElement('span');
      title.className = 'snippet-settings-name';
      title.textContent = snippet.name || snippet.command.split('\n')[0];
      const cmd = document.createElement('span');
      cmd.className = 'snippet-settings-command';
      cmd.textContent = snippet.command.split('\n')[0] + (snippet.command.includes('\n') ? ' …' : '');
      text.append(title, cmd);

      const btn = (label: string, onClick: () => void, extra = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `snippet-settings-btn ${extra}`.trim();
        b.textContent = label;
        b.onclick = onClick;
        return b;
      };
      const up = btn('↑', () => {
        [snippets[index - 1], snippets[index]] = [snippets[index], snippets[index - 1]];
        save();
        render();
      });
      up.title = t('snippetMoveUp');
      up.disabled = index === 0;
      const edit = btn(t('snippetEdit'), () => row.replaceWith(editor(snippet)));
      // Deleting cannot be undone: the first click arms, the second deletes.
      let armTimer = 0;
      const del = btn(t('snippetDelete'), () => {
        if (del.classList.contains('armed')) {
          window.clearTimeout(armTimer);
          snippets = snippets.filter((s) => s.id !== snippet.id);
          save();
          render();
          return;
        }
        del.classList.add('armed');
        del.textContent = t('snippetDeleteConfirm');
        armTimer = window.setTimeout(() => {
          del.classList.remove('armed');
          del.textContent = t('snippetDelete');
        }, 3000);
      }, 'danger');
      row.append(text, up, edit, del);
      container.appendChild(row);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'settings-select settings-test-btn snippet-settings-add';
    add.textContent = t('snippetAdd');
    add.onclick = () => add.replaceWith(editor(null));
    container.appendChild(add);
  }

  render();
  return [container];
}
