import { t } from './i18n';

export function previewTerminalSelection(
  source: string,
  selectedText: string,
  send: (prompt: string) => string | undefined,
): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'ssh-modal ai-terminal-selection';
  dialog.setAttribute('aria-labelledby', 'ai-terminal-selection-title');
  dialog.innerHTML = `
    <header class="ssh-modal-header"><h3 id="ai-terminal-selection-title"></h3></header>
    <form class="ssh-form">
      <label class="ssh-form-group">
        <span class="ai-terminal-selection-source"></span>
        <textarea class="ssh-input ai-terminal-selection-output" rows="7" required spellcheck="false"></textarea>
      </label>
      <label class="ssh-form-group">
        <span class="ai-terminal-selection-question-label"></span>
        <textarea class="ssh-input ai-terminal-selection-question" rows="2" required autofocus></textarea>
      </label>
      <div role="status" class="ai-terminal-selection-status" hidden></div>
      <div class="ssh-form-actions">
        <button type="button" class="ssh-btn ssh-btn-secondary"></button>
        <button type="submit" class="ssh-btn ssh-btn-primary"></button>
      </div>
    </form>
  `;

  const output = dialog.querySelector<HTMLTextAreaElement>('.ai-terminal-selection-output')!;
  const question = dialog.querySelector<HTMLTextAreaElement>('.ai-terminal-selection-question')!;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[type="button"]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const sourceLabel = t('aiTerminalSelectionSource').replace('{source}', () => source);
  dialog.querySelector('h3')!.textContent = t('contextMenuAskAi');
  dialog.querySelector('.ai-terminal-selection-source')!.textContent = sourceLabel;
  dialog.querySelector('.ai-terminal-selection-question-label')!.textContent = t('aiTerminalSelectionQuestion');
  output.value = selectedText;
  question.value = t('aiTerminalSelectionDefaultQuestion');
  cancel.textContent = t('aiDangerConfirmCancel');
  submit.textContent = t('aiTerminalSelectionSend');

  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('contextmenu', (event) => event.stopPropagation());
  dialog.addEventListener('input', () => {
    submit.disabled = !question.value.trim() || !output.value.trim();
  });
  cancel.addEventListener('click', () => dialog.close());
  dialog.querySelector('form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const quotedOutput = output.value.split('\n').map((line) => `> ${line}`).join('\n');
    const error = send(`${question.value.trim()}\n\n${sourceLabel}\n\n${quotedOutput}`);
    if (error) {
      status.textContent = error;
      status.hidden = false;
    } else {
      dialog.close();
    }
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  question.select();
}
