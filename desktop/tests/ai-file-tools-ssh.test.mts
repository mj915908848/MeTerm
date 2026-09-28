import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

function sshFileTools() {
  const file = new URL('../src/ai-tools-file.ts', import.meta.url);
  const source = ts.createSourceFile('ai-tools-file.ts', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['fmtError', 'createReadFileTool', 'createWriteFileTool']);
  const declarations = source.statements
    .filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text))
    .map(node => node.getText(source).replace(/^export\s+/, ''));
  assert.equal(declarations.length, names.size);
  const code = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const tools = new Function('executeViaTerminal', 'invoke', 'resolveLocalToolPath',
    `${code}\nreturn { read: createReadFileTool(), write: createWriteFileTool() };`,
  )(
    async (_sessionId: string, command: string) => execFileSync('sh', ['-c', command], { encoding: 'utf8' }),
    () => assert.fail('SSH tool must not invoke local filesystem command'),
    () => assert.fail('SSH tool must not resolve a local path'),
  );
  const context = { isSSH: true, sessionId: 'test-ssh', shellType: 'bash' };
  return { ...tools, context } as {
    read: { execute: (args: Record<string, unknown>, context: unknown) => Promise<string> };
    write: { execute: (args: Record<string, unknown>, context: unknown) => Promise<string> };
    context: typeof context;
  };
}

test('SSH read_file rejects a nonnumeric maxLines instead of executing it as shell syntax', async () => {
  const { read, context } = sshFileTools();
  const result = await read.execute({ path: '/dev/null', maxLines: "1; printf 'UNEXPECTED_COMMAND'; #" }, context);
  assert.match(result, /^Error:/);
  assert.doesNotMatch(result, /UNEXPECTED_COMMAND/);
});

test('SSH write_file preserves content without a trailing newline', async () => {
  const { write, context } = sshFileTools();
  const dir = mkdtempSync(join(tmpdir(), 'meterm-ssh-write-'));
  try {
    const path = join(dir, 'plain.txt');
    const result = await write.execute({ path, content: 'abc' }, context);
    assert.match(result, /^File written successfully:/);
    assert.deepEqual(readFileSync(path), Buffer.from('abc'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SSH write_file preserves quotes, shell symbols, and existing newlines', async () => {
  const { write, context } = sshFileTools();
  const dir = mkdtempSync(join(tmpdir(), 'meterm-ssh-write-'));
  try {
    const path = join(dir, 'quoted.txt');
    const content = "line 'one' $HOME `pwd`\nline two\n";
    const result = await write.execute({ path, content }, context);
    assert.match(result, /^File written successfully:/);
    assert.deepEqual(readFileSync(path), Buffer.from(content));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
