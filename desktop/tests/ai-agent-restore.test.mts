import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERRUPTED_TOOL_RESULT,
  RESTORED_TOOL_CALL_ID_PREFIX,
  buildRestoredMessages,
} from '../src/ai-agent-restore.ts';
import type { ConvEntry } from '../src/ai-capsule-types.ts';

let clock = 0;
const tick = (): number => ++clock;

const user = (content: string, images?: { mediaType: 'image/png'; data: string }[]): ConvEntry => ({
  type: 'user', content, timestamp: tick(), ...(images ? { images } : {}),
});
const assistant = (content: string): ConvEntry => ({ type: 'assistant', content, timestamp: tick() });
const thinking = (reasoning: string): ConvEntry => ({ type: 'thinking', content: '', reasoning, timestamp: tick() });
const notice = (content: string): ConvEntry => ({ type: 'system', content, timestamp: tick() });
const toolCall = (
  toolName: string,
  args: Record<string, unknown>,
  result: string | null,
  isError = false,
): ConvEntry => ({ type: 'tool_call', toolName, args, result, isError, timestamp: tick() });

test('an empty history restores no context', () => {
  assert.deepEqual(buildRestoredMessages([]), []);
});

test('a reopened conversation seeds the agent with the previous turns', () => {
  const messages = buildRestoredMessages([
    user('看看 nginx 配置'),
    thinking('先确认服务在跑'),
    toolCall('run_command', { command: 'systemctl status nginx' }, 'active (running)'),
    assistant('服务是 running 的'),
  ]);

  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[0].content, '看看 nginx 配置');
  assert.equal(messages[2].content, 'active (running)');
  assert.equal(messages[3].content, '服务是 running 的');
});

test('consecutive tool calls become one assistant message with matching results', () => {
  const messages = buildRestoredMessages([
    user('检查一下'),
    toolCall('read_file', { path: '/etc/nginx/nginx.conf' }, 'worker_processes 1;'),
    toolCall('run_command', { command: 'nginx -t' }, 'syntax is ok'),
    assistant('都正常'),
  ]);

  const assistantWithCalls = messages.find(m => m.tool_calls);
  assert.ok(assistantWithCalls, 'expected one assistant message carrying the tool calls');
  assert.equal(assistantWithCalls.tool_calls!.length, 2);
  assert.deepEqual(
    assistantWithCalls.tool_calls!.map(tc => tc.function.name),
    ['read_file', 'run_command'],
  );
  assert.equal(assistantWithCalls.tool_calls![0].function.arguments, '{"path":"/etc/nginx/nginx.conf"}');

  // Every tool result must reference the call that produced it — a provider
  // rejects the request otherwise.
  const tools = messages.filter(m => m.role === 'tool');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(m => m.tool_call_id), assistantWithCalls.tool_calls!.map(tc => tc.id));
  assert.deepEqual(tools.map(m => m.name), ['read_file', 'run_command']);
  for (const id of assistantWithCalls.tool_calls!.map(tc => tc.id)) {
    assert.ok(id.startsWith(RESTORED_TOOL_CALL_ID_PREFIX), `unexpected id ${id}`);
  }
});

test('every tool result is preceded by its own call in the rebuilt transcript', () => {
  const messages = buildRestoredMessages([
    user('开始'),
    toolCall('run_command', { command: 'ls' }, 'a\nb'),
    toolCall('read_file', { path: '/tmp/x' }, 'x'),
    assistant('ok'),
    notice('[已中断]'),
    user('继续'),
    toolCall('edit_file', { path: '/tmp/x' }, 'done'),
    assistant('改好了'),
  ]);

  let knownCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) {
      knownCallIds = new Set(message.tool_calls.map(tc => tc.id));
    }
    if (message.role === 'tool') {
      assert.ok(
        knownCallIds.has(message.tool_call_id!),
        `tool result ${message.tool_call_id} has no preceding call`,
      );
    }
  }
  assert.equal(messages.filter(m => m.role === 'tool').length, 3);
});

test('thinking becomes reasoning_content on the message it precedes', () => {
  const messages = buildRestoredMessages([
    user('检查磁盘'),
    thinking('用户想确认磁盘空间'),
    toolCall('run_command', { command: 'df -h' }, '80% used'),
    thinking('该汇报结论了'),
    assistant('磁盘用了 80%'),
  ]);

  const withCalls = messages.find(m => m.tool_calls);
  assert.equal(withCalls?.reasoning_content, '用户想确认磁盘空间');
  const finalText = messages[messages.length - 1];
  assert.equal(finalText.role, 'assistant');
  assert.equal(finalText.reasoning_content, '该汇报结论了');
  assert.equal(finalText.content, '磁盘用了 80%');
});

test('UI-only notices stay out of the model context', () => {
  const messages = buildRestoredMessages([
    user('你好'),
    notice('[上下文已压缩]'),
    assistant('你好，要做什么？'),
  ]);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
});

test('an interrupted tool call still gets a result', () => {
  const messages = buildRestoredMessages([
    user('跑一下'),
    toolCall('run_command', { command: 'sleep 600' }, null),
  ]);
  const result = messages.find(m => m.role === 'tool');
  assert.equal(result?.content, INTERRUPTED_TOOL_RESULT);
  assert.equal(messages[messages.length - 1].role, 'tool');
});

test('a transcript that does not start with a user turn is trimmed to one', () => {
  const messages = buildRestoredMessages([
    toolCall('run_command', { command: 'ls' }, 'a'),
    assistant('这是上一轮的回答'),
    user('新问题'),
    assistant('新回答'),
  ]);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(messages[0].content, '新问题');
});

test('images on a user turn are restored as multimodal content parts', () => {
  const messages = buildRestoredMessages([
    user('看这个报错', [{ mediaType: 'image/png', data: 'AAAA' }]),
  ]);
  assert.ok(Array.isArray(messages[0].content));
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '看这个报错' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ]);
});

test('an image-only user turn omits the empty text part', () => {
  const messages = buildRestoredMessages([
    user('', [{ mediaType: 'image/png', data: 'BBBB' }]),
  ]);
  assert.deepEqual(messages[0].content, [{ type: 'image', mediaType: 'image/png', data: 'BBBB' }]);
});

test('arguments that cannot be serialized fall back to an empty object', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const messages = buildRestoredMessages([user('嗯'), toolCall('run_command', circular, 'ok')]);
  const withCalls = messages.find(m => m.tool_calls);
  assert.equal(withCalls?.tool_calls![0].function.arguments, '{}');
});

test('restoring twice from the same history is idempotent', () => {
  const history: ConvEntry[] = [
    user('看看'),
    toolCall('run_command', { command: 'uptime' }, 'load 0.1'),
    assistant('负载很低'),
  ];
  assert.deepEqual(buildRestoredMessages(history), buildRestoredMessages(history));
});


test('tool-call turns retain both assistant text and independent reasoning', () => {
  for (const reasoning of [undefined, '先只读检查']) {
    const history: ConvEntry[] = [
      user('检查配置'),
      { type: 'thinking', content: '备份在 /tmp/backup，接下来检查配置', reasoning, timestamp: tick() },
      toolCall('read_file', { path: '/tmp/config' }, 'ok'),
    ];
    const restored = buildRestoredMessages(history).find(m => m.tool_calls)!;
    assert.equal(restored.content, '备份在 /tmp/backup，接下来检查配置');
    assert.equal(restored.reasoning_content, reasoning);
  }
});

test('interrupted thinking does not leak into a new user turn', () => {
  const restored = buildRestoredMessages([
    user('旧问题'), thinking('未完成的推理'), user('新问题'),
    toolCall('read_file', {}, 'ok'),
  ]);
  assert.equal(restored.find(m => m.tool_calls)?.reasoning_content, undefined);
});

test('tool screenshots retain all image parts and optional text in model context', () => {
  for (const result of ['captured', '']) {
    const restored = buildRestoredMessages([
      user('检查截图'), { ...toolCall('screenshot', {}, result), images: [
        { mediaType: 'image/png', data: 'AAAA' }, { mediaType: 'image/jpeg', data: 'BBBB' },
      ] } as ConvEntry,
    ]);
    assert.deepEqual(restored[2].content, [
      ...(result ? [{ type: 'text', text: result }] : []),
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'image', mediaType: 'image/jpeg', data: 'BBBB' },
    ]);
  }
});

test('text failures restore Error prefix while interrupted calls keep placeholder', () => {
  const restored = buildRestoredMessages([
    user('检查'), toolCall('read_file', {}, 'Permission denied', true), toolCall('read_file', {}, null, true),
  ]);
  assert.equal(restored[2].content, 'Error: Permission denied');
  assert.equal(restored[3].content, INTERRUPTED_TOOL_RESULT);
});

test('multimodal failures retain live unprefixed text format', () => {
  const restored = buildRestoredMessages([
    user('检查'), { ...toolCall('screenshot', {}, 'failed capture', true), images: [{ mediaType: 'image/png', data: 'AAAA' }] } as ConvEntry,
  ]);
  assert.deepEqual(restored[2].content, [
    { type: 'text', text: 'failed capture' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ]);
});
