/**
 * Managing several saved connections at once, on the home page.
 *
 * Multi-select, dragging into a group and batch delete used to live in the
 * standalone connections window. Management now belongs to the home page (the
 * connections drawer only picks), so these pin the home page's half.
 *
 * The drag controller is delegated and works only through DOM contracts agreed
 * with the renderer: a row carries `data-key` and `data-group`, a group card
 * carries `data-group`. The two files never import each other, so nothing but a
 * test keeps the names in step.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const home = read('home-dashboard-left.ts');

/** Slice from `marker` up to the first top-level closing brace line. */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('a home row click goes through the shared selection rules', () => {
  const row = bodyAfter(home, 'function createConnectionRow(');
  assert.ok(row.includes('resolveRowClick('), 'the click rules live in the pure module, not inline here');
  assert.ok(
    /if \(outcome\.connect\) handleConnectionClick\(item, row\)/.test(row),
    'a plain click must still connect, and a modified one must only select',
  );
  assert.ok(row.includes('row.dataset.key = item.key'), 'the drag controller reads the row key');
  assert.ok(row.includes('row.dataset.group ='), 'a row names its group, so a no-op drop can be spotted');
});

test('the row menu acts on the selection only when the row is part of it', () => {
  const row = bodyAfter(home, 'function createConnectionRow(');
  assert.ok(
    row.includes('homePicked.has(item.key) ? [...homePicked] : undefined'),
    'right-clicking a row outside the selection means "just this row"',
  );
});

test('with several rows picked the menu has no edit entry and deletes them all', () => {
  const menu = bodyAfter(home, 'export function showConnectionContextMenu(');
  assert.match(menu, /if \(batch\) \{[\s\S]{0,80}\} else if \(onEdit\)/, 'edit is a one-connection action');
  assert.ok(menu.includes('handleDeleteConnections(moving, refreshView)'), 'delete must cover the whole selection');

  const batch = bodyAfter(home, 'async function handleDeleteConnections(');
  assert.ok(batch.includes('tauriConfirm('), 'deleting several at once asks first');
  assert.ok(batch.includes('for (const target of items)'), 'every picked connection is removed, not just one');
  assert.ok(batch.includes('removeConnectionGroup(target.key)'), 'their group entries go with them');
  assert.equal((batch.match(/refreshView\(\)/g) ?? []).length, 1, 'one re-render at the end, not one per row');
});

test('group cards are drop targets and the per-type cards ungroup', () => {
  assert.ok(home.includes('card.dataset.group = groupName ?? UNGROUPED_DROP_GROUP'));
  assert.ok(
    /card\.dataset\.groupName = `__type:\$\{type\}`;[\s\S]{0,160}card\.dataset\.group = UNGROUPED_DROP_GROUP/.test(home),
    'a drop on the SSH / JumpServer card means "no group"',
  );
  const render = bodyAfter(home, 'export function renderGroupsSection(');
  assert.match(render, /attachConnectionDrag\(groupsGrid,\s*\{[\s\S]*?targetSelector: '\.home-dash-group-card'/);
  assert.ok(render.includes('homeDragDispose?.()'), 'a re-render must not stack a second drag controller');
});

test('a move that changes nothing writes nothing, and a real one is one write', () => {
  const move = bodyAfter(home, 'function moveHomeKeys(');
  assert.ok(move.includes('visibleGroupName(map[key]) !== group'));
  assert.equal((move.match(/assignConnectionsToGroup\(/g) ?? []).length, 1);
});

test('a picked row hidden by the search is dropped from the selection', () => {
  const render = bodyAfter(home, 'export function renderGroupsSection(');
  assert.ok(render.includes('pruneSelection([...homePicked], filteredItems.map((i) => i.key))'));
});

test('the drag controller and the renderers agree on the DOM contract', () => {
  const drag = read('connection-drag.ts');
  const side = read('home-side.ts');
  assert.ok(drag.includes('row.dataset.key'), 'the drag controller reads the row key');
  assert.ok(drag.includes("opts.rowSelector ?? '.home-side-row'"), 'the list rows stay the default');
  assert.ok(drag.includes("opts.targetSelector ?? '.home-side-group'"));
  assert.ok(side.includes('row.dataset.key = item.key') && side.includes('header.dataset.group = g'));
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
  const css = read('styles/home.css');
  const ghost = css.slice(css.indexOf('.cn-drag-ghost'));
  assert.ok(ghost.includes('position: fixed'), 'the ghost follows the pointer');
  assert.ok(ghost.includes('pointer-events: none'), 'or it shadows the card it is hovering');
  assert.ok(css.includes('.home-dash-group-card.drop-target'), 'the hovered card has to be shown as the target');
});
