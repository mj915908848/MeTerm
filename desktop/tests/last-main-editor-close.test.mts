import assert from 'node:assert/strict';
import test from 'node:test';
import { requestEditorCloseBeforeLastMainWindow } from '../src/last-main-editor-close.ts';

test('an approved editor close lets the last main window proceed', async () => {
  let closeRequests = 0;
  const proceed = await requestEditorCloseBeforeLastMainWindow(1, async () => ({
    close: async () => { closeRequests++; },
  }), async editor => { await editor.close(); return true; });
  assert.equal(proceed, true);
  assert.equal(closeRequests, 1);
});

test('a rejected editor close keeps the last main window and its sessions alive', async () => {
  let asked = 0;
  const proceed = await requestEditorCloseBeforeLastMainWindow(1, async () => ({
    close: async () => assert.fail('the editor decides when to close'),
  }), async () => { asked++; return false; });
  assert.equal(proceed, false);
  assert.equal(asked, 1);
});

test('closing continues when no editor is open or another main window remains', async () => {
  assert.equal(await requestEditorCloseBeforeLastMainWindow(1, async () => null, async () => {
    assert.fail('there is no editor to close');
  }), true);
  assert.equal(await requestEditorCloseBeforeLastMainWindow(2, async () => {
    assert.fail('an extra main window does not need to close the shared editor');
  }, async () => assert.fail('no editor request needed')), true);
});

test('an editor lookup or close failure keeps the main window and sessions open', async () => {
  assert.equal(await requestEditorCloseBeforeLastMainWindow(1, async () => {
    throw new Error('lookup failed');
  }, async () => true), false);
  assert.equal(await requestEditorCloseBeforeLastMainWindow(1, async () => ({
    close: async () => { throw new Error('close failed'); },
  }), async editor => { await editor.close(); return true; }), false);
});
