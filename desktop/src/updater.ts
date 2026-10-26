import { openUrl } from '@tauri-apps/plugin-opener';

// Where every "Check for Updates" entry sends the user. This fork has no
// updater service of its own, so updating is a deliberate manual download
// from our own Releases page rather than a silent in-app install.
const RELEASES_URL = 'https://github.com/mj915908848/MeTerm/releases';

// Open the fork's Releases page. Triggered by every "Check for Updates" entry:
// the macOS app menu item, the tray item, and the About tab button.
// The app itself makes no network request and installs nothing by itself.
export function checkUpdateNow(): void {
  void openUrl(RELEASES_URL);
}
