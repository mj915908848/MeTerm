/**
 * How the connection manager creates a group and gets connections into it.
 *
 * The window's list is re-rendered wholesale on every mutation, so the drag
 * controller is delegated and can only work through DOM contracts agreed with the
 * renderer: `.home-side-row` carries the key and the group in `dataset`, and
 * `.home-side-group` is the drop target. Those two files never import each other,
 * so nothing but a test keeps the names in step.
 *
 * The last test is the quieter one. `showGroupContextMenu` deletes a group through
 * a native confirm dialog; a Tauri command that is not granted is rejected with no
 * error reaching the page, so a missing permission reads as a dead menu item. The
 * window is deliberately the least-privileged one, which makes it exactly the
 * place where a new permission gets forgotten.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const readCapability = (): string =>
  fs.readFileSync(new URL('../src-tauri/capabilities/connections.json', import.meta.url), 'utf8');

test('the connection window can create a group', () => {
  const source = read('connections-window.ts');
  assert.ok(
    /newGroupBtn\.onclick\s*=\s*\(\)\s*=>/.test(source),
    'the window needs its own entry point — the new-connection grid forwards to the main window, which owns sessions',
  );
  assert.ok(
    source.includes("showGroupModal('', '', (name, color) =>"),
    'creating a group must reuse the shared group modal, so name and colour behave as they do on the home view',
  );
  assert.ok(
    source.includes('createGroup(name)'),
    'the modal alone does not create anything',
  );
});

test('a group made in this window is also manageable in this window', () => {
  const source = read('connections-window.ts');
  assert.ok(
    source.includes('showGroupContextMenu(event, group, afterMutation)'),
    'rename / colour / delete have to be reachable where the group was created, or the feature is a dead end',
  );
  assert.ok(
    read('home-dashboard-left.ts').includes('export function showGroupContextMenu('),
    'the shared group menu must be exported for the second window to use it',
  );
});

test('group deletion can reach the native confirm it asks for', () => {
  const capability = readCapability();
  assert.ok(
    /"dialog:allow-confirm"/.test(capability),
    'showGroupContextMenu deletes a group through a native confirm; without this the menu item silently does nothing',
  );
});

test('the list is wired for dragging rows onto a group', () => {
  const source = read('connections-window.ts');
  assert.match(
    source,
    /attachConnectionDrag\(listScroll,\s*\{[\s\S]*?onDrop:/,
    'the rows must be draggable onto a group header',
  );
  assert.ok(
    source.includes('assignConnectionsToGroup(keys, group)'),
    'a drop must move the whole selection in one write, not row by row',
  );
});

test('a multi-row selection is not allowed to become the primary action', () => {
  const source = read('connections-window.ts');
  assert.match(
    source,
    /return outcome\.connect;/,
    'the row handler must let a plain click through and swallow every modified one',
  );
  assert.ok(
    source.includes('resolveRowClick(visibleKeys'),
    'the click rules live in the pure module, not inline here',
  );
});

test('the drag controller and the renderer agree on the DOM contract', () => {
  const renderer = read('home-side.ts');
  const drag = read('connection-drag.ts');

  assert.ok(renderer.includes('row.dataset.key = item.key'), 'the renderer must publish each row key');
  assert.ok(drag.includes("row.dataset.key"), 'the drag controller reads that key');

  assert.ok(renderer.includes('header.dataset.group = g'), 'the renderer must publish each group name');
  assert.ok(renderer.includes("row.dataset.group = g"), 'a row has to name its group, so dropping anywhere in a group works');
  assert.ok(drag.includes('home-side-group'), 'the drag controller looks for the group header');
  assert.ok(drag.includes('home-side-row'), 'the drag controller looks for rows');
});

test('a drag never becomes a session click, and does not outlive the gesture', () => {
  const drag = read('connection-drag.ts');
  assert.ok(drag.includes('stopPropagation()'), 'the click left over from a drag must be swallowed');
  assert.ok(
    /setTimeout\(\(\)\s*=>\s*document\.removeEventListener\('click'/.test(drag),
    'a drop outside any row produces no click, so the swallow must disarm itself',
  );
  assert.ok(drag.includes("'Escape'"), 'Escape has to cancel the drag');
});

test('the drop ghost cannot become the drop target', () => {
  // The target is found with elementFromPoint, and the ghost sits under the
  // cursor: without pointer-events: none it would always be what is found.
  const css = read('styles/connections-window.css');
  const ghost = css.slice(css.indexOf('.cn-drag-ghost'));
  assert.ok(ghost.includes('position: fixed'), 'the ghost follows the pointer');
  assert.ok(ghost.includes('pointer-events: none'), 'or it shadows the row it is hovering');
  assert.ok(css.includes('.drop-target'), 'the hovered group has to be shown as the drop target');
});
