/**
 * home-connection-manager.ts — the home page's saved-connection manager.
 *
 * Two panes: the grouped connection list on the left, the selected connection
 * on the right. A selected SSH connection is shown read-only first (its facts
 * and connect / edit / duplicate / delete); "edit" swaps in the SSH form,
 * embedded in the pane instead of a modal, and saving returns to the view.
 *
 * A single click only *selects*. Connecting takes a double-click, Enter, or the
 * "connect" button — on a page for managing connections, a click that opens a
 * session is too easy to trigger by accident. (The connections drawer is for
 * picking, so a click there still connects.)
 *
 * ⌘/Ctrl-click and Shift-click select several (rules in connection-selection.ts);
 * the right pane then offers the batch actions. Rows drag onto a group header.
 * With nothing selected, the right pane shows the page's start content: search,
 * the new-session grid and recent connections. The "home" entry at the top of
 * the list is the way back to it.
 */
import { t } from './i18n';
import { settings } from './app-state';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { renderSidebarList } from './home-side';
import {
  collectAllConnections,
  createAssetHistoryRow,
  renderRecentActivity,
  editConnection,
  escapeHtml,
  handleConnectionClick,
  handleDeleteConnections,
  showGroupContextMenu,
  showGroupModal,
  showActionMenu,
  showMoveMenu,
  type ConnectionItem,
} from './home-dashboard-left';
import {
  assignConnectionsToGroup,
  createGroup,
  getJSAssetHistoryByFrequency,
  loadGroupMap,
  loadGroupOrder,
  setGroupColor,
  sshKey,
  visibleGroupName,
} from './connection-groups';
import { attachConnectionDrag } from './connection-drag';
import { pruneSelection, resolveRowClick } from './connection-selection';
import { icon } from './icons';
import { showGroupSortMenu } from './group-sort-menu';
import { UNGROUPED_GROUP } from './connection-sort';
import { createEmbeddedSSHForm, loadRecentConnections, type SSHConnectionConfig } from './ssh';
import type { JumpServerConfig } from './jumpserver-api';

/** Bilingual text for strings that are not in the i18n table or carry a count. */
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

// Selection outlives the view: the home page is rebuilt on every switch back to
// it, and coming back should show the connection you were looking at.
let picked: string[] = [];
let anchor: string | null = null;
/** "new" shows an empty SSH form (or a prefilled copy) in the right pane. */
let draft: { prefill?: SSHConnectionConfig } | null = null;
/** The one selected SSH connection is open in its form rather than its read-only view. */
let editing = false;

const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>';

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

/** The SSH dialog's pill buttons, so the page reads as one with the form it embeds. */
function button(label: string, onClick: () => void, kind: 'primary' | 'danger' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ssh-btn ssh-btn-${kind}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

/** A quiet square button holding just an icon ("+", "⋯"). */
function iconButton(svg: string, label: string, onClick: (el: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hcm-icon-btn';
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'menu');
  b.onclick = () => onClick(b);
  return b;
}

export function createConnectionManager(startContent: HTMLElement): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hcm';

  // ── Left pane: the list ──
  const left = document.createElement('div');
  left.className = 'hcm-list-pane';

  const toolbar = document.createElement('div');
  toolbar.className = 'hcm-toolbar';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'home-side-search hcm-search';
  searchWrap.innerHTML = `<span class="home-side-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg></span>`;
  const searchInput = document.createElement('input');
  searchInput.className = 'home-side-search-input';
  searchInput.type = 'text';
  searchInput.id = 'hcm-search';
  searchInput.placeholder = L('筛选连接…', 'Filter connections…');
  searchInput.setAttribute('aria-label', searchInput.placeholder);
  searchWrap.appendChild(searchInput);
  // New connection / new group live behind one "+" so the list starts higher.
  const addBtn = iconButton(icon('plus'), L('新建', 'New'), (el) => {
    showActionMenu(el, [
      { label: L('新建 SSH 连接', 'New SSH connection'), onPick: () => { void select([], null, {}); } },
      {
        label: L('新建分组', 'New group'),
        onPick: () => {
          showGroupModal('', '', (name, color) => {
            createGroup(name);
            if (color) setGroupColor(name, color);
            announce();
          });
        },
      },
    ]);
  });
  // One sort control for the whole list; a single group's sort is in its
  // header's right-click menu.
  const sortBtn = iconButton(icon('sort'), t('connectionSort'), (el) => {
    showGroupSortMenu(el, [...loadGroupOrder(), UNGROUPED_GROUP], announce);
  });
  sortBtn.classList.add('hcm-sort-btn');
  toolbar.append(searchWrap, sortBtn, addBtn);
  left.appendChild(toolbar);

  // The way back to the start content once a connection is selected. Drawn as
  // a list row so it reads as the first entry of the list.
  const homeNav = document.createElement('button');
  homeNav.type = 'button';
  homeNav.className = 'home-side-row hcm-home';
  homeNav.innerHTML = `<span class="hsr-icon">${icon('home')}</span><span class="hsr-name">${escapeHtml(L('首页', 'Home'))}</span>`;
  left.appendChild(homeNav);

  const groupHeader = document.createElement('div');
  groupHeader.className = 'home-side-grouphdr';
  left.appendChild(groupHeader);

  const list = document.createElement('div');
  list.className = 'home-side-list hcm-list';
  list.tabIndex = 0;
  list.setAttribute('aria-label', L('已保存的连接', 'Saved connections'));
  createOverlayScrollbar({ viewport: list, container: list });
  left.appendChild(list);

  // ── Right pane: whatever is selected ──
  const right = document.createElement('div');
  right.className = 'hcm-detail-pane';

  root.append(left, right);

  /** The embedded form currently shown, so a switch can ask before dropping edits. */
  let form: { isDirty: () => boolean } | null = null;
  /** What the right pane currently shows, so a refresh does not rebuild a form being typed in. */
  let shownKey = '';

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

  /** Change what is selected (and so what the right pane shows), asking first if a form has unsaved edits. */
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
    renderDetail();
  };

  const moveKeys = (keys: readonly string[], group: string | null): void => {
    if (keys.length === 0) return;
    const map = loadGroupMap();
    if (!keys.some((key) => visibleGroupName(map[key]) !== group)) return;
    assignConnectionsToGroup(keys, group);
    announce();
  };

  /** A connection changed: re-render this page (and anything else listening). */
  const announce = (): void => {
    document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
  };

  const renderList = (): void => {
    const scrollTop = list.scrollTop;
    renderSidebarList(list, groupHeader, searchInput.value.trim(), {
      onSelect: connect,
      refresh: announce,
      getSelectedKey: () => (picked.length === 1 ? picked[0] : null),
      isRowSelected: (key) => picked.length > 1 && picked.includes(key),
      getSelection: () => [...picked],
      // "Edit" from the row menu opens the connection here, where it is edited.
      onEdit: (item) => { void select([item.key], item.key); },
      onRowClick: (item, mods, visibleKeys) => {
        const outcome = resolveRowClick(visibleKeys, { selection: picked, anchor }, item.key, mods);
        // A plain click selects; it never connects on this page.
        void select(outcome.connect ? [item.key] : outcome.selection, outcome.anchor);
        return false;
      },
      onRowActivate: connect,
      onGroupContextMenu: (event, group) => {
        // The ungrouped bucket has nothing to rename or colour: just its sort.
        if (group === null) showGroupSortMenu({ x: event.clientX, y: event.clientY }, UNGROUPED_GROUP, announce);
        else showGroupContextMenu(event, group, announce);
      },
    });
    list.scrollTop = scrollTop;
  };

  // ── Right pane renderers ──

  /** The centred column the detail renderers fill. */
  let body: HTMLElement = right;

  const header = (title: string, subtitle: string, buttons: HTMLElement[], kind?: ConnectionItem['type']): HTMLElement => {
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
    text.innerHTML = `<div class="hcm-detail-name">${escapeHtml(title)}</div>`
      + (subtitle ? `<div class="hcm-detail-sub">${escapeHtml(subtitle)}</div>` : '');
    const btns = document.createElement('div');
    btns.className = 'hcm-detail-actions';
    btns.append(...buttons);
    el.append(text, btns);
    return el;
  };

  const deleteKeys = (keys: string[]): void => {
    void handleDeleteConnections(keys, () => {
      // The re-render prunes the deleted keys out of the selection.
      form = null;
      shownKey = '';
      announce();
    });
  };

  /** When this connection was last opened, from the recent list (same host/port/user). */
  const lastUsedLabel = (config: SSHConnectionConfig): string => {
    const recent = loadRecentConnections();
    const index = recent.findIndex((r) => r.host === config.host && (r.port || 22) === (config.port || 22) && r.username === config.username);
    if (index < 0) return '';
    return index === 0 ? L('最近一次连接', 'Most recently used') : L(`最近连接第 ${index + 1} 位`, `#${index + 1} in recent connections`);
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

  const showSsh = (item: ConnectionItem): void => {
    const config = item.raw as SSHConnectionConfig;
    const address = `${config.username}@${config.host}:${config.port || 22}`;
    if (editing) {
      body.appendChild(header(item.name, L('编辑连接', 'Edit connection'), [
        button(L('取消', 'Cancel'), () => { void setEditing(false); }),
      ], 'ssh'));
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

    body.appendChild(header(item.name, address, [
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
    ], 'ssh'));
    const facts = factList();
    facts.add(L('主机', 'Host'), config.host);
    facts.add(L('端口', 'Port'), String(config.port || 22));
    facts.add(L('用户', 'User'), config.username);
    facts.add(L('认证', 'Auth'), authLabel(config));
    facts.add(L('分组', 'Group'), visibleGroupName(loadGroupMap()[item.key]) ?? t('homeGroupUngrouped'));
    if (config.proxyType && config.proxyHost) {
      facts.add(L('代理', 'Proxy'), `${config.proxyType.toUpperCase()} ${config.proxyHost}${config.proxyPort ? `:${config.proxyPort}` : ''}`);
    }
    facts.add(L('最近使用', 'Last used'), lastUsedLabel(config));
    body.appendChild(facts.el);
  };

  const tip = (text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'hcm-tip';
    el.textContent = text;
    return el;
  };

  const showNewSsh = (prefill?: SSHConnectionConfig): void => {
    body.appendChild(header(
      prefill ? L('复制连接', 'Duplicate connection') : L('新建 SSH 连接', 'New SSH connection'),
      L('填写后保存，连接会出现在左侧列表里', 'Save it and it appears in the list on the left'),
      [button(L('取消', 'Cancel'), () => { void select([], null); })],
    ));
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
    body.appendChild(header(item.name, `${config.username}@${config.sshHost}:${config.sshPort}`, [
      button(t('sshConnectBtn'), () => connect(item), 'primary'),
      button(t('homeEditConnection'), () => editConnection(item, announce)),
      iconButton(MORE_ICON, L('更多', 'More'), (el) => {
        showActionMenu(el, [{ label: t('sshDeleteConnection'), danger: true, onPick: () => deleteKeys([item.key]) }]);
      }),
    ], 'jumpserver'));
    const facts = factList();
    facts.add('API', config.baseUrl);
    facts.add(L('用户', 'User'), config.username);
    facts.add(L('认证', 'Auth'), config.authMethod === 'token' ? 'Token' : L('密码', 'Password'));
    facts.add(L('分组', 'Group'), visibleGroupName(loadGroupMap()[item.key]) ?? t('homeGroupUngrouped'));
    body.appendChild(facts.el);

    const history = getJSAssetHistoryByFrequency(config.name).slice(0, 8);
    if (history.length > 0) {
      const title = document.createElement('div');
      title.className = 'hcm-section-title';
      title.textContent = L('常用资产（单击连接）', 'Frequent assets (click to connect)');
      body.appendChild(title);
      const box = document.createElement('div');
      box.className = 'hcm-assets';
      for (const entry of history) box.appendChild(createAssetHistoryRow(entry, config));
      body.appendChild(box);
    }
  };

  const showBatch = (keys: string[]): void => {
    const chosen = items().filter((i) => keys.includes(i.key));
    const moveBtn = button(t('connectionMoveToGroup'), () => {
      showMoveMenu(moveBtn, loadGroupOrder(), (group) => moveKeys(keys, group));
    });
    body.appendChild(header(L(`已选 ${chosen.length} 个连接`, `${chosen.length} connections selected`), '', [
      moveBtn,
      button(t('sshDeleteConnection'), () => deleteKeys(keys), 'danger'),
      button(t('connectionClearSelection'), () => { void select([], null); }),
    ]));
    const names = document.createElement('ul');
    names.className = 'hcm-batch-list';
    for (const item of chosen) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="hcm-batch-detail">${escapeHtml(item.detail)}</span>`;
      names.appendChild(li);
    }
    body.appendChild(names);
    body.appendChild(tip(L('也可以把选中的连接拖到左侧的分组上', 'You can also drag the selection onto a group on the left')));
  };

  const renderDetail = (): void => {
    const key = draft ? `draft:${draft.prefill?.name ?? ''}` : `${editing ? 'edit:' : ''}${picked.join('\n')}`;
    // Re-rendering the same form would throw away what is being typed.
    if (key === shownKey && form) return;
    shownKey = key;
    form = null;
    right.replaceChildren();
    right.scrollTop = 0;

    const item = picked.length === 1 ? itemFor(picked[0]) : undefined;
    const atHome = !draft && picked.length <= 1 && !item;
    homeNav.classList.toggle('active', atHome);
    homeNav.setAttribute('aria-current', atHome ? 'page' : 'false');
    if (atHome) {
      right.appendChild(startContent);
      // The recent track renders by id, so it can only be refreshed while attached.
      renderRecentActivity('');
      return;
    }

    body = document.createElement('div');
    body.className = 'hcm-detail-body';
    right.appendChild(body);
    if (draft) showNewSsh(draft.prefill);
    else if (picked.length > 1) showBatch(picked);
    else if (item?.type === 'ssh') showSsh(item);
    else if (item?.type === 'jumpserver') showJumpServer(item);
  };

  const render = (): void => {
    picked = pruneSelection(picked, items().map((i) => i.key));
    if (anchor && !picked.includes(anchor) && !items().some((i) => i.key === anchor)) anchor = null;
    renderList();
    renderDetail();
  };

  // ── Wiring ──

  searchInput.addEventListener('input', renderList);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; renderList(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); list.focus(); moveCursor(1); }
  });
  homeNav.onclick = () => { void select([], null); };

  /** Arrow keys walk the visible rows; Enter connects the selected one. */
  const visibleRowKeys = (): string[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.hcm-list-pane .home-side-row[data-key]')).map((r) => r.dataset.key!);
  const moveCursor = (step: number): void => {
    const keys = visibleRowKeys();
    if (keys.length === 0) return;
    const current = picked.length === 1 ? keys.indexOf(picked[0]) : -1;
    const next = keys[Math.max(0, Math.min(keys.length - 1, current < 0 ? (step > 0 ? 0 : keys.length - 1) : current + step))];
    void select([next], next).then(() => {
      root.querySelector<HTMLElement>(`.hcm-list-pane .home-side-row[data-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };
  list.addEventListener('keydown', (e) => {
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

  attachConnectionDrag(list, {
    getSelection: () => [...picked],
    dragLabel: (count) => L(`${count} 个连接`, `${count} connection${count === 1 ? '' : 's'}`),
    onDrop: (group, keys) => moveKeys(keys, group),
  });

  mounted = { root, refresh: render };
  render();
  return root;
}
