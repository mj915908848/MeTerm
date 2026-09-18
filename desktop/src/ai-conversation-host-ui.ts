import { DrawerManager } from './drawer';
import { TabManager } from './tabs';
import { getAllLeaves } from './split-pane';
import { t } from './i18n';
import { showToast } from './notify';
import { hostsMatch, sshConversationHost, type ConversationHost } from './ai-conversation-host';
import type { AICapsuleInstance, ChatConversation } from './ai-capsule-types';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { renderMarkdown } from './ai-capsule-markdown';
import { confirm } from '@tauri-apps/plugin-dialog';
import { buildToolCard } from './ai-capsule-tool-ui';
import { thinkingIcon } from './ai-icons';

export function currentConversationHost(instance: AICapsuleInstance): ConversationHost {
  const located = TabManager.locateSession(instance.sessionId);
  const leaf = located ? getAllLeaves(located.tab.splitRoot).find(p => p.id === located.tab.focusedPaneId) : undefined;
  const info = DrawerManager.getServerInfo(leaf?.sessionId ?? instance.sessionId);
  return info ? sshConversationHost(info.host, info.port) : { kind: 'local' };
}
export function conversationHostLabel(host: ConversationHost | undefined): string {
  return !host ? t('aiChatHostUnbound') : host.kind === 'local' ? t('aiChatHostLocal') : host.displayName;
}
export function allowConversationSend(instance: AICapsuleInstance): boolean {
  if (!instance.conversationHost || hostsMatch(instance.conversationHost, currentConversationHost(instance))) return true;
  showToast({ title: t('aiChatHostMismatchTitle'), body: t('aiChatHostMismatch') });
  return false;
}

/** Independent preview: no agent, terminal execution, or restore callbacks. */
export function previewHostConversation(conv: ChatConversation, instance: AICapsuleInstance, bind?: (host: ConversationHost) => Promise<void>): void {
  const panel = instance.chatHistoryPanel;
  const inline = panel?.classList.contains('ai-side-chat-history-view') ? panel : null;
  const previousNodes = inline ? Array.from(inline.childNodes) : [];
  const previousScroll = inline?.scrollTop ?? 0;
  const overlay = document.createElement('div'); overlay.className = 'ai-history-preview-drawer';
  const dialog = document.createElement('section'); dialog.className = 'ai-history-preview';
  if (inline) dialog.classList.add('ai-history-preview-inline');
  dialog.setAttribute('role', 'region'); dialog.setAttribute('aria-label', t('aiChatPreviewAriaLabel')); dialog.tabIndex = -1;
  const heading = document.createElement('h3'); heading.textContent = `${conv.title} · ${conversationHostLabel(conv.hostBinding)}`;
  const notice = document.createElement('p'); notice.textContent = conv.hostBinding
    ? t('aiChatPreviewNoticeBound')
    : t('aiChatPreviewNoticeUnbound');
  const close = document.createElement('button'); close.textContent = inline ? t('aiChatPreviewBack') : t('aiChatPreviewClose');
  close.className = 'ai-history-preview-back';
  if (inline) close.textContent = '← ' + t('aiChatPreviewBack');
  const copy = document.createElement('button'); copy.textContent = t('aiChatCopyConversation');
  copy.onclick = async () => {
    const text = conv.messages.map(message => message.type === 'tool_call'
      ? `${message.toolName}\n${JSON.stringify(message.args, null, 2)}\n${message.result ?? ''}`
      : `${message.type}: ${message.content}${message.type === 'thinking' && message.reasoning ? '\n' + message.reasoning : ''}`).join('\n\n');
    try { await writeText(text); copy.textContent = t('commonCopied'); }
    catch { copy.textContent = t('aiChatCopyFailed'); }
  };
  const previousFocus = document.activeElement as HTMLElement | null;
  let bindingChanged = false;
  const dismiss = () => {
    if (inline && dialog.parentElement === inline) {
      inline.replaceChildren(...previousNodes); inline.scrollTop = previousScroll;
    } else overlay.remove();
    if (bindingChanged && panel?.isConnected) panel.dispatchEvent(new Event('ai-history-bound'));
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  close.onclick = dismiss;
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
  });
  dialog.append(close, heading, notice, copy);
  if (!conv.hostBinding && bind) {
    const button = document.createElement('button'); button.textContent = t('aiChatBindCurrentHost');
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    button.onclick = async () => {
      if (button.disabled) return;
      const target = currentConversationHost(instance);
      button.disabled = true;
      try {
        const accepted = await confirm(
          t('aiChatBindConfirmBody').replace('{host}', conversationHostLabel(target)),
          { title: t('aiChatBindConfirmTitle'), kind: 'warning' });
        if (!accepted) return;
        await bind(target);
        bindingChanged = true;
        if (!dialog.isConnected && panel?.isConnected) panel.dispatchEvent(new Event('ai-history-bound'));
        button.remove();
        heading.textContent = `${conv.title} · ${conversationHostLabel(target)}`;
        notice.textContent = t('aiChatBindSuccessNotice');
        status.textContent = t('aiChatBindSuccessStatus');
      } catch {
        status.textContent = t('aiChatBindFailedStatus');
      } finally { button.disabled = false; }
    };
    dialog.append(button, status);
  }
  const body = document.createElement('div'); body.className = 'ai-history-preview-body ai-chat-messages';
  for (const message of conv.messages) {
    if (message.type === 'tool_call') {
      body.append(buildToolCard(message));
      continue;
    }
    if (message.type === 'thinking' && message.reasoning) {
      const block = document.createElement('div'); block.className = 'ai-thinking-block';
      const details = document.createElement('details'); details.className = 'ai-reasoning';
      const summary = document.createElement('summary');
      summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
      const reasoning = document.createElement('div'); reasoning.className = 'ai-reasoning-text';
      reasoning.textContent = message.reasoning.replace(/<\/?think(?:ing)?>/gi, '').replace(/<\/(?:arg_value|tool_call|args|tool_use)>/gi, '');
      details.append(summary, reasoning); block.append(details); body.append(block);
    }
    if (message.type === 'thinking' && !message.content) continue;
    const row = document.createElement('div');
    row.className = message.type === 'system' ? 'ai-system-notice'
      : `ai-msg ai-msg-${message.type === 'user' ? 'user' : 'assistant'}`;
    if (message.type === 'assistant' || message.type === 'thinking') {
      const content = document.createElement('div'); content.className = 'ai-msg-content';
      content.innerHTML = renderMarkdown(message.content, '', () => {}, { allowRun: false });
      row.append(content);
    } else {
      const content = document.createElement('div'); content.className = 'ai-msg-content';
      content.textContent = message.content;
      row.append(content);
    }
    if ('images' in message && message.images) {
      const images = document.createElement('div'); images.className = 'ai-user-images';
      for (const image of message.images) {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mediaType)) continue;
        const img = document.createElement('img'); img.src = `data:${image.mediaType};base64,${image.data}`;
        img.alt = t('aiChatHistoryImageAlt'); img.loading = 'lazy';
        const thumb = document.createElement('div'); thumb.className = 'ai-user-image-thumb'; thumb.append(img); images.append(thumb);
      }
      row.append(images);
    }
    body.append(row);
  }
  body.querySelectorAll<HTMLButtonElement>('.ai-response-copy, .ai-cmd-copy').forEach(button => {
    button.onclick = async () => {
      try { await writeText(button.dataset.code ?? ''); button.textContent = t('commonCopied'); }
      catch { button.textContent = t('aiChatCopyFailed'); }
    };
  });
  dialog.append(body);
  if (inline) { inline.replaceChildren(dialog); inline.scrollTop = 0; }
  else { overlay.append(dialog); document.body.append(overlay); }
  close.focus();
}
