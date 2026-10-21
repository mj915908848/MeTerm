/**
 * home-connection-manager.ts — the home page: every saved connection in one table.
 *
 * Layout: a header (title, the page's search box, "local terminal", "+ new"),
 * a row of filter chips (all, one per group, ungrouped, JumpServer), the table
 * (name, address, user, group, last used; click a column header to sort), and
 * an inspector on the right while something is selected.
 *
 * A single click only *selects* and opens the inspector. Connecting takes a
 * double-click, Enter, the row's "connect" button or its right-click menu — on
 * a page for managing connections, a click that opens a session is too easy to
 * trigger by accident. (The connections drawer is for picking, so a click there
 * still connects.)
 *
 * ⌘/Ctrl-click and Shift-click select several (rules in connection-selection.ts);
 * the inspector then offers the batch actions. Rows drag onto a group chip.
 * A selected SSH connection is shown read-only first; "edit" swaps in the SSH
 * form, embedded in the inspector, and saving returns to the view.
 */
import { t } from './i18n';
import { settings } from './app-state';
import {
  collectAllConnections,
  createAssetHistoryRow,
  editConnection,
  escapeHtml,
  filterConnections,
  handleConnectionClick,
  handleDeleteConnections,
  loadConnectionLastUsed,
  showActionMenu,
  showConnectionContextMenu,
  showGroupContextMenu,
  showGroupModal,
  showMoveMenu,
  type ConnectionItem,
} from './home-dashboard-left';
import {
  assignConnectionsToGroup,
  createGroup,
  getJSAssetHistoryByFrequency,
  loadGroupColors,
  loadGroupMap,
  loadGroupOrder,
  setGroupColor,
  sshKey,
  visibleGroupName,
} from './connection-groups';
import { attachConnectionDrag, UNGROUPED_DROP_GROUP } from './connection-drag';
import { pruneSelection, resolveRowClick } from './connection-selection';
import { runNewConnectionAction } from './connection-sidebar';
import { icon } from './icons';
import { createEmbeddedSSHForm, loadRecentConnections, type SSHConnectionConfig } from './ssh';
import type { JumpServerConfig } from './jumpserver-api';

/** Bilingual text for strings that are not in the i18n table or carry a count. */
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SORT_KEY = 'meterm-home-table-sort';

type Column = 'name' | 'address' | 'user' | 'group' | 'used';
interface SortState { col: Column; dir: 1 | -1 }

/** Which rows the chips let through: everything, one group, the ungrouped bucket, or JumpServers. */
type Filter = 'all' | 'ungrouped' | 'jumpserver' | `group:${string}`;

// Selection and filter outlive the view: the home page is rebuilt on every
// switch back to it, and coming back should show what you were looking at.
let picked: string[] = [];
let anchor: string | null = null;
/** "new" shows an empty SSH form (or a prefilled copy) in the inspector. */
let draft: { prefill?: SSHConnectionConfig } | null = null;
/** The one selected SSH connection is open in its form rather than its read-only view. */
let editing = false;
let filter: Filter = 'all';

interface Mounted {
  root: HTMLElement;
  refresh: () => void;
}
let mounted: Mounted | null = null;

/** Re-render the manager if the home page is showing it. */
export function refreshConnectionManager(): void {
  if (mounted && !mounted.root.isConnected) mounted = null;
  mounted?.refresh();
}

function loadSort(): SortState {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (raw && ['name', 'address', 'user', 'group', 'used'].includes(raw.col) && (raw.dir === 1 || raw.dir === -1)) return raw;
  } catch {}
  return { col: 'name', dir: 1 };
}

function saveSort(sort: SortState): void {
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch {}
}

/** The SSH dialog's pill buttons, so the page reads as one with the form it embeds. */
function button(label: string, onClick: () => void, kind: 'primary' | 'danger' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ssh-btn ssh-btn-${kind}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

/** A quiet square button holding just an icon ("⋯", "✕"). */
function iconButton(svg: string, label: string, onClick: (el: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hcm-icon-btn';
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = (event) => { event?.stopPropagation(); onClick(b); };
  return b;
}

/** "刚刚", "5 分钟前", "3 天前", or a date. */
function relativeTime(ts: number, now: number): string {
  const minutes = Math.floor((now - ts) / 60000);
  if (minutes < 1) return L('刚刚', 'just now');
  if (minutes < 60) return L(`${minutes} 分钟前`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return L(`${hours} 小时前`, `${hours} h ago`);
  const days = Math.floor(hours / 24);
  if (days < 30) return L(`${days} 天前`, `${days} d ago`);
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Row {
  item: ConnectionItem;
  address: string;
  user: string;
  group: string | null;
  /** Sort weight for "last used": a timestamp, else a small number for a recent-list entry, else 0. */
  used: number;
  usedLabel: string;
}

export interface ConnectionManagerOptions {
  /** The page's search row (input + results overlay); it also filters the table. */
  searchRow: HTMLElement;
  searchInput: HTMLInputElement;
}

export function createConnectionManager(opts: ConnectionManagerOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hcm';

  const main = document.createElement('div');
  main.className = 'hcm-main';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'hcm-header';
  const title = document.createElement('h1');
  title.className = 'hcm-title';
  title.textContent = L('连接', 'Connections');
  const count = document.createElement('span');
  count.className = 'hcm-count';
  opts.searchRow.classList.add('hcm-search-row');
  const localBtn = button(t('homeNewLocalSession'), () => runNewConnectionAction('local'));
  localBtn.classList.add('hcm-header-btn');
  const newBtn = button(`+ ${L('新建', 'New')}`, () => {
    showActionMenu(newBtn, [
      { label: L('SSH 连接', 'SSH connection'), onPick: () => { void select([], null, {}); } },
      { label: 'JumpServer', onPick: () => runNewConnectionAction('jumpserver') },
      { label: L('分组', 'Group'), onPick: newGroup },
    ]);
  }, 'primary');
  newBtn.classList.add('hcm-header-btn');
  newBtn.setAttribute('aria-haspopup', 'menu');
  header.append(title, count, opts.searchRow, localBtn, newBtn);

  // ── Filter chips ──
  const chips = document.createElement('div');
  chips.className = 'hcm-chips';
  chips.setAttribute('role', 'toolbar');
  chips.setAttribute('aria-label', L('按分组筛选', 'Filter by group'));

  // ── Table ──
  const table = document.createElement('div');
  table.className = 'hcm-table';
  const thead = document.createElement('div');
  thead.className = 'hcm-thead';
  const tbody = document.createElement('div');
  tbody.className = 'hcm-tbody';
  tbody.tabIndex = 0;
  tbody.setAttribute('aria-label', L('已保存的连接', 'Saved connections'));
  table.append(thead, tbody);

  const hint = document.createElement('div');
  hint.className = 'hcm-hint';
  hint.textContent = L(
    '单击选中 · 双击或回车连接 · 右键更多操作 · ⌘/Ctrl 多选 · 拖到分组标签上移动',
    'Click to select · double-click or Enter to connect · right-click for more · ⌘/Ctrl to multi-select · drag onto a group chip to move',
  );

  main.append(header, chips, table, hint);

  // ── Inspector ──
  const inspector = document.createElement('aside');
  inspector.className = 'hcm-inspector';
  inspector.setAttribute('aria-label', L('连接详情', 'Connection details'));

  root.append(main, inspector);

  let sort = loadSort();
  /** The embedded form currently shown, so a switch can ask before dropping edits. */
  let form: { isDirty: () => boolean } | null = null;
  /** What the inspector currently shows, so a refresh does not rebuild a form being typed in. */
  let shownKey = '';
  let visibleKeys: string[] = [];

  const confirmDiscard = async (): Promise<boolean> => {
    if (!form?.isDirty()) return true;
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return confirm(t('sshUnsavedConfirm'), { title: t('sshUnsavedConfirm'), kind: 'warning' });
  };

  const items = (): ConnectionItem[] => collectAllConnections();
  const itemFor = (key: string): ConnectionItem | undefined => items().find((i) => i.key === key);

  const connect = (item: ConnectionItem): void => {
    handleConnectionClick(item);
  };

  /** A connection changed: re-render this page (and anything else listening). */
  const announce = (): void => {
    document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
  };

  /** Change what is selected (and so what the inspector shows), asking first if a form has unsaved edits. */
  const select = async (keys: string[], nextAnchor: string | null, nextDraft: typeof draft = null): Promise<void> => {
    const same = keys.join('\n') === picked.join('\n') && nextDraft === draft;
    if (same) { anchor = nextAnchor; return; }
    if (!(await confirmDiscard())) return;
    picked = keys;
    anchor = nextAnchor;
    draft = nextDraft;
    editing = false;
    render();
  };

  /** Switch the selected SSH connection between its view and its form. */
  const setEditing = async (on: boolean): Promise<void> => {
    if (!on && !(await confirmDiscard())) return;
    editing = on;
    renderInspector();
  };

  const moveKeys = (keys: readonly string[], group: string | null): void => {
    if (keys.length === 0) return;
    const map = loadGroupMap();
    if (!keys.some((key) => visibleGroupName(map[key]) !== group)) return;
    assignConnectionsToGroup(keys, group);
    announce();
  };

  function newGroup(): void {
    showGroupModal('', '', (name, color) => {
      createGroup(name);
      if (color) setGroupColor(name, color);
      announce();
    });
  }

  const deleteKeys = (keys: string[]): void => {
    void handleDeleteConnections(keys, () => {
      // The re-render prunes the deleted keys out of the selection.
      form = null;
      shownKey = '';
      announce();
    });
  };

  // ── Rows ──

  const buildRows = (): Row[] => {
    const map = loadGroupMap();
    const lastUsed = loadConnectionLastUsed();
    const recent = loadRecentConnections();
    const now = Date.now();
    return items().map((item) => {
      let address: string;
      let user: string;
      if (item.type === 'ssh') {
        const c = item.raw as SSHConnectionConfig;
        address = `${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ''}`;
        user = c.username;
      } else {
        const j = item.raw as JumpServerConfig;
        address = `${j.sshHost}:${j.sshPort}`;
        user = j.username;
      }
      let used = 0;
      let usedLabel = '—';
      const ts = lastUsed[item.key];
      if (ts) {
        used = ts;
        usedLabel = relativeTime(ts, now);
      } else if (item.type === 'ssh') {
        // Opened before the app kept times: the recent list still orders it.
        const c = item.raw as SSHConnectionConfig;
        const index = recent.findIndex((r) => r.host === c.host && (r.port || 22) === (c.port || 22) && r.username === c.username);
        if (index >= 0) { used = 10 - index; usedLabel = L('最近', 'recently'); }
      }
      return { item, address, user, group: visibleGroupName(map[item.key]), used, usedLabel };
    });
  };

  const passesFilter = (row: Row): boolean => {
    if (filter === 'all') return true;
    if (filter === 'jumpserver') return row.item.type === 'jumpserver';
    if (filter === 'ungrouped') return row.group === null;
    return row.group === filter.slice('group:'.length);
  };

  const compare = (a: Row, b: Row): number => {
    const text = (x: string, y: string): number => x.localeCompare(y, settings?.language === 'zh' ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
    let diff = 0;
    switch (sort.col) {
      case 'name': diff = text(a.item.name, b.item.name); break;
      case 'address': diff = text(a.address, b.address); break;
      case 'user': diff = text(a.user, b.user); break;
      case 'group': diff = text(a.group ?? '￿', b.group ?? '￿'); break;
      // Most recent first reads as "ascending" for this column.
      case 'used': diff = b.used - a.used; break;
    }
    return diff * sort.dir || text(a.item.name, b.item.name);
  };

  const COLUMNS: [Column, string][] = [
    ['name', L('名称', 'Name')],
    ['address', L('地址', 'Address')],
    ['user', L('用户', 'User')],
    ['group', L('分组', 'Group')],
    ['used', L('最近使用', 'Last used')],
  ];

  const renderHead = (): void => {
    thead.replaceChildren();
    thead.appendChild(document.createElement('span'));
    for (const [col, label] of COLUMNS) {
      const th = document.createElement('button');
      th.type = 'button';
      th.className = 'hcm-th' + (sort.col === col ? ' active' : '');
      th.dataset.col = col;
      th.textContent = sort.col === col ? `${label} ${sort.dir === 1 ? '↑' : '↓'}` : label;
      th.setAttribute('aria-sort', sort.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.onclick = () => {
        sort = sort.col === col ? { col, dir: sort.dir === 1 ? -1 : 1 } : { col, dir: 1 };
        saveSort(sort);
        renderTable();
      };
      thead.appendChild(th);
    }
    thead.appendChild(document.createElement('span'));
  };

  const dotHtml = (color: string | undefined): string =>
    color && /^#[0-9a-f]{3,8}$/i.test(color) ? `<span class="hcm-dot" style="background:${color}"></span>` : '<span class="hcm-dot hcm-dot-none"></span>';

  const renderChips = (rows: Row[]): void => {
    chips.replaceChildren();
    const groupColors = loadGroupColors();
    const chip = (value: Filter, label: string, n: number, extra: { color?: string; group?: string; kind?: string } = {}): void => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'hcm-chip' + (filter === value ? ' active' : '') + (extra.kind ? ` hcm-chip-${extra.kind}` : '');
      el.setAttribute('aria-pressed', String(filter === value));
      if (extra.group !== undefined) el.dataset.group = extra.group;
      el.innerHTML = `${extra.color !== undefined ? dotHtml(extra.color) : ''}<span>${escapeHtml(label)}</span><span class="hcm-chip-count">${n}</span>`;
      el.onclick = () => { filter = filter === value && value !== 'all' ? 'all' : value; renderTable(); };
      if (extra.group && extra.group !== UNGROUPED_DROP_GROUP) {
        const group = extra.group;
        el.oncontextmenu = (event) => { event.preventDefault(); showGroupContextMenu(event, group, announce); };
      }
      chips.appendChild(el);
    };
    chip('all', L('全部', 'All'), rows.length);
    for (const g of loadGroupOrder()) {
      chip(`group:${g}`, g, rows.filter((r) => r.group === g).length, { color: groupColors[g] ?? '', group: g });
    }
    chip('ungrouped', t('homeGroupUngrouped'), rows.filter((r) => r.group === null).length, { group: UNGROUPED_DROP_GROUP });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'hcm-chip hcm-chip-add';
    add.textContent = `+ ${L('分组', 'Group')}`;
    add.onclick = newGroup;
    chips.appendChild(add);
    const jumpservers = rows.filter((r) => r.item.type === 'jumpserver').length;
    if (jumpservers > 0) {
      const sep = document.createElement('span');
      sep.className = 'hcm-chip-sep';
      chips.appendChild(sep);
      chip('jumpserver', 'JumpServer', jumpservers, { kind: 'jumpserver' });
    }
  };

  const renderTable = (): void => {
    const all = buildRows();
    if (filter.startsWith('group:') && !loadGroupOrder().includes(filter.slice('group:'.length))) filter = 'all';
    renderChips(all);
    renderHead();
    count.textContent = L(`${all.length} 个`, `${all.length}`);

    const query = opts.searchInput.value.trim();
    const matching = new Set(filterConnections(all.map((r) => r.item), query).map((i) => i.key));
    const rows = all.filter((r) => matching.has(r.item.key) && passesFilter(r)).sort(compare);
    visibleKeys = rows.map((r) => r.item.key);

    const scrollTop = tbody.scrollTop;
    tbody.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hcm-empty';
      empty.textContent = all.length === 0
        ? L('还没有保存的连接，点右上角「+ 新建」添加', 'No saved connections yet. Use "+ New" to add one.')
        : L('没有符合条件的连接', 'No matching connections');
      tbody.appendChild(empty);
      return;
    }
    const groupColors = loadGroupColors();
    for (const r of rows) {
      const { item } = r;
      const row = document.createElement('div');
      const isPicked = picked.includes(item.key);
      row.className = `hcm-row hcm-row-${item.type}` + (isPicked ? ' selected' : '');
      row.dataset.key = item.key;
      row.setAttribute('aria-selected', String(isPicked));
      row.title = `${item.name} — ${item.detail}`;
      row.innerHTML = `<span class="hcm-cell-icon">${icon(item.type === 'jumpserver' ? 'jumpserver' : 'ssh')}</span>`
        + `<span class="hcm-cell hcm-cell-name">${escapeHtml(item.name)}</span>`
        + `<span class="hcm-cell hcm-cell-muted">${escapeHtml(r.address)}</span>`
        + `<span class="hcm-cell hcm-cell-muted">${escapeHtml(r.user)}</span>`
        + `<span class="hcm-cell hcm-cell-group">${r.group ? `${dotHtml(groupColors[r.group])}${escapeHtml(r.group)}` : `<span class="hcm-cell-dim">${escapeHtml(t('homeGroupUngrouped'))}</span>`}</span>`
        + `<span class="hcm-cell hcm-cell-muted">${escapeHtml(r.usedLabel)}</span>`;
      const actions = document.createElement('span');
      actions.className = 'hcm-row-actions';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'hcm-row-connect';
      go.textContent = t('sshConnectBtn');
      go.onclick = (event) => { event.stopPropagation(); connect(item); };
      const more = iconButton(MORE_ICON, L('更多', 'More'), () => {
        const rect = more.getBoundingClientRect();
        showConnectionContextMenu(
          { clientX: rect.left, clientY: rect.bottom + 4 } as MouseEvent,
          item, r.group, announce, () => { void select([item.key], item.key).then(() => setEditing(true)); },
        );
      });
      actions.append(go, more);
      row.appendChild(actions);

      row.onclick = (event) => {
        const mods = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
        const outcome = resolveRowClick(visibleKeys, { selection: picked, anchor }, item.key, mods);
        // A plain click selects; it never connects on this page.
        void select(outcome.connect ? [item.key] : outcome.selection, outcome.anchor);
      };
      row.ondblclick = (event) => {
        if ((event.target as HTMLElement).closest?.('.hcm-row-actions')) return;
        connect(item);
      };
      row.oncontextmenu = (event) => {
        event.preventDefault();
        const batch = picked.length > 1 && picked.includes(item.key) ? picked : undefined;
        showConnectionContextMenu(event, item, r.group, announce,
          () => { void select([item.key], item.key).then(() => setEditing(true)); }, batch);
      };
      tbody.appendChild(row);
    }
    tbody.scrollTop = scrollTop;
  };

  // ── Inspector renderers ──

  /** The column the inspector renderers fill. */
  let body: HTMLElement = inspector;

  const detailHeader = (name: string, subtitle: string, kind?: ConnectionItem['type']): void => {
    const el = document.createElement('div');
    el.className = 'hcm-detail-header';
    if (kind) {
      const tile = document.createElement('div');
      tile.className = `hcm-detail-icon hcm-detail-icon-${kind}`;
      tile.innerHTML = icon(kind === 'jumpserver' ? 'jumpserver' : 'ssh');
      el.appendChild(tile);
    }
    const text = document.createElement('div');
    text.className = 'hcm-detail-title';
    text.innerHTML = `<div class="hcm-detail-name">${escapeHtml(name)}</div>`
      + (subtitle ? `<div class="hcm-detail-sub">${escapeHtml(subtitle)}</div>` : '');
    el.appendChild(text);
    body.appendChild(el);
  };

  const actionRow = (buttons: HTMLElement[]): void => {
    const el = document.createElement('div');
    el.className = 'hcm-detail-actions';
    el.append(...buttons);
    body.appendChild(el);
  };

  const factList = (): { el: HTMLElement; add: (label: string, value: string) => void } => {
    const el = document.createElement('div');
    el.className = 'hcm-facts';
    const add = (label: string, value: string): void => {
      if (!value) return;
      const row = document.createElement('div');
      row.className = 'hcm-fact';
      const name = document.createElement('span');
      name.className = 'hcm-fact-label';
      name.textContent = label;
      const text = document.createElement('span');
      text.className = 'hcm-fact-value';
      text.textContent = value;
      row.append(name, text);
      el.appendChild(row);
    };
    return { el, add };
  };

  const authLabel = (config: SSHConnectionConfig): string => {
    if (config.authMethod === 'password') return L('密码', 'Password');
    if (config.usesDesktopKeyLadder) return L('SSH Agent / 默认密钥', 'SSH agent / default keys');
    return L('私钥', 'Private key');
  };

  const rowFor = (key: string): Row | undefined => buildRows().find((r) => r.item.key === key);

  const showSsh = (item: ConnectionItem): void => {
    const config = item.raw as SSHConnectionConfig;
    const address = `${config.username}@${config.host}:${config.port || 22}`;
    if (editing) {
      detailHeader(item.name, L('编辑连接', 'Edit connection'), 'ssh');
      actionRow([button(L('取消', 'Cancel'), () => { void setEditing(false); })]);
      const embedded = createEmbeddedSSHForm(config, (saved) => {
        // A rename moves the key; keep the saved connection selected.
        picked = [sshKey(saved.name)];
        anchor = picked[0];
        editing = false;
        form = null;
        shownKey = '';
        announce();
      });
      form = embedded;
      body.appendChild(embedded.el);
      return;
    }

    detailHeader(item.name, address, 'ssh');
    actionRow([
      button(t('sshConnectBtn'), () => connect(item), 'primary'),
      button(t('homeEditConnection'), () => { void setEditing(true); }),
      iconButton(MORE_ICON, L('更多', 'More'), (el) => {
        showActionMenu(el, [
          {
            label: L('复制为新连接', 'Duplicate'),
            onPick: () => {
              const copy: SSHConnectionConfig = { ...config, serverConnectionId: undefined, name: `${config.name} ${L('副本', 'copy')}` };
              void select([], null, { prefill: copy });
            },
          },
          { label: t('sshDeleteConnection'), danger: true, onPick: () => deleteKeys([item.key]) },
        ]);
      }),
    ]);
    const row = rowFor(item.key);
    const facts = factList();
    facts.add(L('主机', 'Host'), config.host);
    facts.add(L('端口', 'Port'), String(config.port || 22));
    facts.add(L('用户', 'User'), config.username);
    facts.add(L('认证', 'Auth'), authLabel(config));
    facts.add(L('分组', 'Group'), row?.group ?? t('homeGroupUngrouped'));
    if (config.proxyType && config.proxyHost) {
      facts.add(L('代理', 'Proxy'), `${config.proxyType.toUpperCase()} ${config.proxyHost}${config.proxyPort ? `:${config.proxyPort}` : ''}`);
    }
    facts.add(L('最近使用', 'Last used'), row && row.usedLabel !== '—' ? row.usedLabel : '');
    body.appendChild(facts.el);
  };

  const showNewSsh = (prefill?: SSHConnectionConfig): void => {
    detailHeader(
      prefill ? L('复制连接', 'Duplicate connection') : L('新建 SSH 连接', 'New SSH connection'),
      L('保存后出现在表格里', 'Save it and it appears in the table'),
      'ssh',
    );
    actionRow([button(L('取消', 'Cancel'), () => { void select([], null); })]);
    const embedded = createEmbeddedSSHForm(prefill, (saved) => {
      picked = [sshKey(saved.name)];
      anchor = picked[0];
      draft = null;
      form = null;
      shownKey = '';
      announce();
    });
    form = embedded;
    body.appendChild(embedded.el);
    requestAnimationFrame(() => embedded.el.querySelector<HTMLInputElement>('input')?.focus());
  };

  const showJumpServer = (item: ConnectionItem): void => {
    const config = item.raw as JumpServerConfig;
    detailHeader(item.name, `${config.username}@${config.sshHost}:${config.sshPort}`, 'jumpserver');
    actionRow([
      button(t('sshConnectBtn'), () => connect(item), 'primary'),
      button(t('homeEditConnection'), () => editConnection(item, announce)),
      iconButton(MORE_ICON, L('更多', 'More'), (el) => {
        showActionMenu(el, [{ label: t('sshDeleteConnection'), danger: true, onPick: () => deleteKeys([item.key]) }]);
      }),
    ]);
    const row = rowFor(item.key);
    const facts = factList();
    facts.add('API', config.baseUrl);
    facts.add(L('用户', 'User'), config.username);
    facts.add(L('认证', 'Auth'), config.authMethod === 'token' ? 'Token' : L('密码', 'Password'));
    facts.add(L('分组', 'Group'), row?.group ?? t('homeGroupUngrouped'));
    body.appendChild(facts.el);

    const history = getJSAssetHistoryByFrequency(config.name).slice(0, 8);
    if (history.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'hcm-section-title';
      heading.textContent = L('常用资产（单击连接）', 'Frequent assets (click to connect)');
      body.appendChild(heading);
      const box = document.createElement('div');
      box.className = 'hcm-assets';
      for (const entry of history) box.appendChild(createAssetHistoryRow(entry, config));
      body.appendChild(box);
    }
  };

  const showBatch = (keys: string[]): void => {
    const chosen = items().filter((i) => keys.includes(i.key));
    detailHeader(L(`已选 ${chosen.length} 个连接`, `${chosen.length} connections selected`), '');
    const moveBtn = button(t('connectionMoveToGroup'), () => {
      showMoveMenu(moveBtn, loadGroupOrder(), (group) => moveKeys(keys, group));
    });
    actionRow([moveBtn, button(t('sshDeleteConnection'), () => deleteKeys(keys), 'danger')]);
    const names = document.createElement('ul');
    names.className = 'hcm-batch-list';
    for (const item of chosen) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="hcm-batch-detail">${escapeHtml(item.detail)}</span>`;
      names.appendChild(li);
    }
    body.appendChild(names);
    const tip = document.createElement('div');
    tip.className = 'hcm-tip';
    tip.textContent = L('也可以把选中的连接拖到上面的分组标签上', 'You can also drag the selection onto a group chip above');
    body.appendChild(tip);
  };

  const renderInspector = (): void => {
    const item = picked.length === 1 ? itemFor(picked[0]) : undefined;
    const open = !!draft || picked.length > 1 || !!item;
    root.classList.toggle('has-inspector', open);
    const key = draft ? `draft:${draft.prefill?.name ?? ''}` : `${editing ? 'edit:' : ''}${picked.join('\n')}`;
    // Re-rendering the same form would throw away what is being typed.
    if (key === shownKey && form) return;
    shownKey = key;
    form = null;
    inspector.replaceChildren();
    if (!open) return;

    const top = document.createElement('div');
    top.className = 'hcm-inspector-top';
    const label = document.createElement('span');
    label.textContent = draft ? L('新建', 'New') : L('已选中', 'Selected');
    top.append(label, iconButton(CLOSE_ICON, L('关闭', 'Close'), () => { void select([], null); }));
    inspector.appendChild(top);

    body = document.createElement('div');
    body.className = 'hcm-inspector-body';
    inspector.appendChild(body);
    if (draft) showNewSsh(draft.prefill);
    else if (picked.length > 1) showBatch(picked);
    else if (item?.type === 'ssh') showSsh(item);
    else if (item?.type === 'jumpserver') showJumpServer(item);
  };

  const render = (): void => {
    picked = pruneSelection(picked, items().map((i) => i.key));
    if (anchor && !picked.includes(anchor) && !items().some((i) => i.key === anchor)) anchor = null;
    renderTable();
    renderInspector();
  };

  // ── Wiring ──

  opts.searchInput.addEventListener('input', renderTable);

  /** Arrow keys walk the visible rows; Enter connects the selected one. */
  const moveCursor = (step: number): void => {
    if (visibleKeys.length === 0) return;
    const current = picked.length === 1 ? visibleKeys.indexOf(picked[0]) : -1;
    const next = visibleKeys[Math.max(0, Math.min(visibleKeys.length - 1, current < 0 ? (step > 0 ? 0 : visibleKeys.length - 1) : current + step))];
    void select([next], next).then(() => {
      tbody.querySelector<HTMLElement>(`.hcm-row[data-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };
  tbody.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && picked.length === 1) {
      const item = itemFor(picked[0]);
      if (item) { e.preventDefault(); connect(item); }
    } else if (e.key === 'Escape' && picked.length > 0) {
      void select([], null);
    }
  });

  attachConnectionDrag(tbody, {
    getSelection: () => [...picked],
    dragLabel: (n) => L(`${n} 个连接`, `${n} connection${n === 1 ? '' : 's'}`),
    onDrop: (group, keys) => moveKeys(keys, group),
    rowSelector: '.hcm-row',
    targetSelector: '.hcm-chip[data-group]',
    ignoreSelector: '.hcm-row-actions',
    rowsAreTargets: false,
  });

  mounted = { root, refresh: render };
  render();
  return root;
}
