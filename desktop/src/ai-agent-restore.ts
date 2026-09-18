// ─── AI Agent: rebuild the model context from persisted chat history ───
//
// A saved conversation stores UI-facing entries (`ConvEntry`, see
// ai-capsule-types.ts) while the agent talks to the model in a different shape
// (`ChatMessage`, see ai-provider.ts). Reopening a saved conversation used to
// restore only the former, so the model received an empty context and silently
// restarted the task from scratch — the chat panel showed the previous turns,
// the model saw none of them.
//
// `buildRestoredMessages` maps the persisted log back into the very message
// shapes `ToolAgent.runLoop` produces for a live turn, so the next user message
// continues the previous work and the model still knows which operations already
// ran and what they returned.
//
// Pure module: only type-only imports, no Tauri / DOM access, so the mapping is
// unit-testable under Node (see tests/ai-agent-restore.test.mts).

import type { ChatMessage, ContentPart, ToolCall } from './ai-provider';
import type { ConvEntry } from './ai-capsule-types';

/** Synthetic tool-call ids carry this prefix so they can never collide with ids
 *  the live provider issued during the original run. */
export const RESTORED_TOOL_CALL_ID_PREFIX = 'restored_call_';

/** Substituted for a tool call that was persisted without a result — the run was
 *  interrupted (cancel / crash) before the tool returned. The transcript must
 *  still answer every tool call, or the provider rejects the request. */
export const INTERRUPTED_TOOL_RESULT =
  '[No result recorded — the previous run was interrupted after this tool call]';

type UserEntry = Extract<ConvEntry, { type: 'user' }>;
type ToolEntry = Extract<ConvEntry, { type: 'tool_call' }>;

function stringifyArgs(args: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}

/** Mirror how `ToolAgent.send()` stores a multimodal user turn: the text part is
 *  only present when there is text, images follow in order. */
function userContent(entry: UserEntry): string | ContentPart[] {
  const images = entry.images ?? [];
  if (images.length === 0) return entry.content;

  const parts: ContentPart[] = [];
  if (entry.content) parts.push({ type: 'text', text: entry.content });
  for (const img of images) {
    parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
  }
  return parts;
}

/** 恢复工具输出的图片和错误标记，与实时消息保持一致。
 * Restore image parts and error markers using the live message format. */
function toolContent(entry: ToolEntry): ChatMessage['content'] {
  if (entry.result === null) return INTERRUPTED_TOOL_RESULT;
  if (!entry.images?.length) return entry.isError ? `Error: ${entry.result}` : entry.result;
  const parts: ContentPart[] = [];
  if (entry.result) parts.push({ type: 'text', text: entry.result });
  for (const image of entry.images) {
    parts.push({ type: 'image', mediaType: image.mediaType, data: image.data });
  }
  return parts;
}

/**
 * Rebuild the agent's `ChatMessage[]` from persisted conversation entries.
 *
 * Mapping rules, chosen to match what a live run puts into `agent.messages`:
 *  - consecutive `tool_call` entries belong to ONE assistant message carrying
 *    all of them, immediately followed by one `tool` message per call (the
 *    provider layer requires each tool result to reference a preceding call);
 *  - `thinking` is attached as `reasoning_content` on the message it precedes,
 *    which is what thinking-mode providers expect to be echoed back;
 *  - `system` entries are UI-only notices (abort / compression banners) and were
 *    never part of the model context, so they are skipped;
 *  - the transcript is trimmed to start at a `user` turn, because a leading
 *    assistant turn or a bare tool result is rejected by the providers.
 */
export function buildRestoredMessages(entries: readonly ConvEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingReasoning = '';
  let pendingText = '';
  let pendingCalls: ToolCall[] = [];
  let pendingResults: ChatMessage['content'][] = [];
  let callSeq = 0;

  /** Close the open tool batch as one assistant message + its tool results. */
  const flushToolBatch = (): void => {
    if (pendingCalls.length === 0) return;
    const calls = pendingCalls;
    const results = pendingResults;
    const reasoning = pendingReasoning;
    const text = pendingText;
    pendingText = '';
    pendingCalls = [];
    pendingResults = [];
    pendingReasoning = '';

    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: calls,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
    for (let i = 0; i < calls.length; i++) {
      messages.push({
        role: 'tool',
        tool_call_id: calls[i].id,
        name: calls[i].function.name,
        content: results[i],
      });
    }
  };

  const pushAssistantText = (content: string): void => {
    pendingText = '';
    const reasoning = pendingReasoning;
    pendingReasoning = '';
    messages.push({
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
  };

  for (const entry of entries) {
    switch (entry.type) {
      case 'user':
        flushToolBatch();
        pendingText = '';
        pendingReasoning = '';
        messages.push({ role: 'user', content: userContent(entry) });
        break;

      case 'thinking':
        // Reasoning belongs to the message that follows it. Close any batch
        // opened before it first, so tool results stay adjacent to their calls.
        flushToolBatch();
        pendingText = entry.content || '';
        pendingReasoning = entry.reasoning || '';
        break;

      case 'assistant':
        flushToolBatch();
        if (entry.content) pushAssistantText(entry.content);
        break;

      case 'tool_call': {
        const id = `${RESTORED_TOOL_CALL_ID_PREFIX}${callSeq++}`;
        pendingCalls.push({
          id,
          type: 'function',
          function: { name: entry.toolName, arguments: stringifyArgs(entry.args) },
        });
        pendingResults.push(toolContent(entry));
        break;
      }

      case 'system':
        break;
    }
  }
  flushToolBatch();

  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }

  return messages;
}
