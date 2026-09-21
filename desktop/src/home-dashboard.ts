/**
 * Empty state shown when there is no active session. This is a minimal
 * "no session" placeholder with the "new connection" buttons plus the list of
 * servers this device recently connected to (click a row to reconnect).
 */
import { settings } from './app-state';
import { makeNewButtons } from './connection-sidebar';
import { renderHomeRecentConnections } from './home-dashboard-left';

// Re-export names kept for ssh.ts / view-manager backwards compat.
export { createDashboardHomeView as createSSHHomeView, updateDashboardHomeView as updateSSHHomeView };

const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

export function createDashboardHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view home-empty-view';
  container.id = 'home-view';

  const card = document.createElement('div');
  card.className = 'home-empty-card';
  card.innerHTML = `<div class="home-empty-title">${L('暂无会话', 'No active session')}</div>`
    + `<div class="home-empty-sub">${L('新建一个终端，或从下面的最近连接里直接打开。', 'Open a terminal, or pick a recent connection below.')}</div>`;
  card.appendChild(makeNewButtons());

  // Recent-connection history — filled by renderHomeRecentConnections().
  const recent = document.createElement('div');
  recent.className = 'home-recent';
  recent.id = 'home-recent-connections';
  card.appendChild(recent);

  container.appendChild(card);
  renderHomeRecentConnections();

  return container;
}

export function updateDashboardHomeView(): void {
  renderHomeRecentConnections();
}
