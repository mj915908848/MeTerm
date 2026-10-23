import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { quoteRemotePath, resolveSftpPath } from '../src/ai-remote-path.ts';
import * as sudoFile from '../src/ai-sudo-file.ts';

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Session without SFTP: every sftp_* command fails the way the backend does. */
const noSftp: Invoke = async (command) => {
  assert.match(command, /^sftp_/, 'SSH tool must not invoke a local filesystem command');
  throw 'SFTP not available for this session';
};

function sshFileTools(invoke: Invoke = noSftp, cwd = '', env: NodeJS.ProcessEnv = process.env) {
  const file = new URL('../src/ai-tools-file.ts', import.meta.url);
  const source = ts.createSourceFile('ai-tools-file.ts', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(['fmtError', 'sftpUnavailable', 'formatReadResult', 'createReadFileTool', 'createWriteFileTool', 'createEditFileTool', 'wantsSudo', 'sudoUnsupported', 'withSudoTemp']);
  const declarations = source.statements
    .filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text))
    .map(node => node.getText(source).replace(/^export\s+/, ''));
  assert.equal(declarations.length, names.size);
  const constants = source.statements
    .filter((node): node is ts.VariableStatement => ts.isVariableStatement(node))
    .map(node => node.getText(source));
  const code = ts.transpileModule([...constants, ...declarations].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sudoNames = ['commitSucceeded', 'describeSudoFailure', 'parseTempPath', 'removeTempCommand', 'sudoCommitCommand', 'sudoStageCommand', 'tempFileCommand'] as const;
  const tools = new Function('executeViaTerminal', 'invoke', 'resolveLocalToolPath', 'quoteRemotePath', 'resolveSftpPath', 'hasSensitivePathComponent', ...sudoNames,
    `${code}\nreturn { read: createReadFileTool(), write: createWriteFileTool(), edit: createEditFileTool() };`,
  )(
    async (_sessionId: string, command: string) => {
      try {
        return execFileSync('sh', ['-c', command], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        return `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
    },
    invoke,
    () => assert.fail('SSH tool must not resolve a local path'),
    quoteRemotePath,
    resolveSftpPath,
    () => false,
    ...sudoNames.map(name => sudoFile[name]),
  );
  const context = { isSSH: true, sessionId: 'test-ssh', shellType: 'bash', cwd };
  type Tool = { execute: (args: Record<string, unknown>, context: unknown) => Promise<string> };
  return { ...tools, context } as { read: Tool; write: Tool; edit: Tool; context: typeof context };
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

test('SSH read_file and write_file expand a ~/ path on the remote side', async () => {
  const { read, write, context } = sshFileTools();
  const home = mkdtempSync(join(tmpdir(), 'meterm-ssh-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await write.execute({ path: '~/sub/note.txt', content: 'hello' }, context);
    assert.match(result, /^File written successfully:/);
    assert.equal(readFileSync(join(home, 'sub/note.txt'), 'utf8'), 'hello');
    assert.equal(await read.execute({ path: '~/sub/note.txt' }, context), 'hello');
  } finally {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('SSH read_file without SFTP honours offset and limit', async () => {
  const { read, context } = sshFileTools();
  const dir = mkdtempSync(join(tmpdir(), 'meterm-ssh-read-'));
  try {
    const path = join(dir, 'lines.txt');
    writeFileSync(path, 'one\ntwo\nthree\nfour\n');
    assert.equal(await read.execute({ path, offset: 2, limit: 2 }, context), 'two\nthree\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SSH file tools go over SFTP when it is available, with ~ and cwd resolved', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const sftp: Invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'sftp_read_file') {
      return { content: 'b\nc', size: 8, is_binary: false, too_large: false, truncated: true, total_lines: 4 };
    }
    if (command === 'sftp_write_file') return 5;
    if (command === 'sftp_edit_file') return { replacements: 1, first_line: 3, size: 42 };
    throw new Error(`unexpected ${command}`);
  };
  const { read, write, edit, context } = sshFileTools(sftp, '/srv/app');
  const shown = await read.execute({ path: 'notes.txt', offset: 2, limit: 2 }, context);
  assert.match(shown, /^b\nc\n\n--- Showing lines 2-3 of 4 .*offset=4/);
  assert.match(await write.execute({ path: '~/x.txt', content: 'hello' }, context), /^File written successfully/);
  assert.match(await edit.execute({ path: '/etc/app.conf', old_string: 'a', new_string: 'b' }, context), /^File edited: .*line 3/);
  assert.deepEqual(calls.map(([command, args]) => [command, args.path]), [
    ['sftp_read_file', '/srv/app/notes.txt'],
    ['sftp_write_file', 'x.txt'],
    ['sftp_edit_file', '/etc/app.conf'],
  ]);
  assert.equal(calls[0][1].startLine, 2);
  assert.equal(calls[2][1].replaceAll, false);
});

test('read_file caps a result by characters, not only by lines', async () => {
  const longLines = Array.from({ length: 200 }, (_, i) => `${i + 1} ${'x'.repeat(500)}`).join('\n');
  const { read, context } = sshFileTools(async () => (
    { content: longLines, size: longLines.length, is_binary: false, too_large: false, truncated: true, total_lines: 900 }
  ), '/srv');
  const shown = await read.execute({ path: '/srv/big.log' }, context);
  assert.ok(shown.length < 17000, `result is ${shown.length} chars`);
  const footer = /--- Showing lines 1-(\d+) of 900 .*offset=(\d+)\. ---$/.exec(shown)!;
  assert.ok(footer, shown.slice(-200));
  assert.equal(Number(footer[2]), Number(footer[1]) + 1);

  const oneLine = 'y'.repeat(100_000);
  const { read: readOne } = sshFileTools(async () => (
    { content: oneLine, size: oneLine.length, is_binary: false, too_large: false, truncated: false, total_lines: 1 }
  ), '/srv');
  const cut = await readOne.execute({ path: '/srv/min.js' }, context);
  assert.ok(cut.length < 17000);
  assert.match(cut, /Line 1 is longer than 16000 characters and was cut\..*offset=2\. ---$/);
});

test('SSH edit_file reports a non-unique match instead of guessing', async () => {
  const { edit, context } = sshFileTools(async () => { throw 'old_string occurs 2 times in the file.'; });
  assert.match(await edit.execute({ path: '/a', old_string: 'x', new_string: 'y' }, context), /^Error editing file: old_string occurs 2 times/);
});

/** A fake `sudo` on PATH: `-n` succeeds and runs the command, or fails like sudo when NEEDS_PW is set. */
function fakeSudoEnv(dir: string, needsPassword = false): NodeJS.ProcessEnv {
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'sudo'), needsPassword
    ? '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n'
    : '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

/** SFTP stand-in that works on local files, for the temp-file leg of sudo. */
const localSftp: Invoke = async (command, args) => {
  const path = String(args.path);
  if (command === 'sftp_read_file') {
    const content = readFileSync(path, 'utf8');
    return { content, size: content.length, is_binary: false, too_large: false, truncated: false, total_lines: null };
  }
  if (command === 'sftp_write_file') { writeFileSync(path, String(args.content)); return String(args.content).length; }
  if (command === 'sftp_edit_file') {
    const before = readFileSync(path, 'utf8');
    if (!before.includes(String(args.oldString))) throw 'old_string not found in the file.';
    writeFileSync(path, before.replace(String(args.oldString), String(args.newString)));
    return { replacements: 1, first_line: 1, size: before.length };
  }
  throw new Error(`unexpected ${command}`);
};

test('sudo edit_file / write_file / read_file stage through a temp file and write back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meterm-sudo-'));
  try {
    const target = join(dir, "it's.conf");
    writeFileSync(target, 'listen 80;\nserver_name a;\n');
    const { read, write, edit, context } = sshFileTools(localSftp, '', fakeSudoEnv(dir));
    assert.match(await edit.execute({ path: target, old_string: 'listen 80;', new_string: 'listen 8080;', sudo: true }, context), /^File edited/);
    assert.equal(readFileSync(target, 'utf8'), 'listen 8080;\nserver_name a;\n');
    assert.match(await read.execute({ path: target, sudo: true }, context), /listen 8080;/);
    const created = join(dir, 'new dir', 'x.conf');
    assert.match(await write.execute({ path: created, content: 'a=1', sudo: true }, context), /^File written successfully with sudo/);
    assert.equal(readFileSync(created, 'utf8'), 'a=1');
    const failed = await edit.execute({ path: target, old_string: 'missing', new_string: 'x', sudo: true }, context);
    assert.match(failed, /^Error editing file: old_string not found/);
    assert.equal(readFileSync(target, 'utf8'), 'listen 8080;\nserver_name a;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sudo file tools explain a password prompt instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meterm-sudo-'));
  try {
    const target = join(dir, 'a.conf');
    writeFileSync(target, 'x');
    const { edit, context } = sshFileTools(localSftp, '', fakeSudoEnv(dir, true));
    const result = await edit.execute({ path: target, old_string: 'x', new_string: 'y', sudo: true }, context);
    assert.match(result, /sudo needs a password.*sudo -v/s);
    assert.equal(readFileSync(target, 'utf8'), 'x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sudo=true is refused on local sessions', async () => {
  const { edit } = sshFileTools();
  const local = { isSSH: false, sessionId: 'local', shellType: 'zsh', cwd: '/' };
  assert.match(await edit.execute({ path: '/etc/hosts', old_string: 'a', new_string: 'b', sudo: true }, local), /only supported on SSH/);
});
