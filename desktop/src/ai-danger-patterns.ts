// ─── Command danger heuristics ─────────────────────────────
// Shared by the agent's run_command permission check and the capsule's
// "run this command" button. Kept import-free so node tests can load it.

/** Downloads piped or substituted straight into an interpreter. */
const FETCH_AND_EXECUTE = [
  /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b/,
  /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(python[0-9.]*|perl|ruby|node)\b/,
  /\b(ba|z|da|k)?sh\s+(-s\s+)?<\(\s*(curl|wget|fetch)\b/,
  /\b(source|eval)\s+["']?(<\(|\$\()\s*(curl|wget|fetch)\b/,
  /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|\s*(iex|Invoke-Expression)\b/i,
];

export const DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/,   // rm -r, rm -rf, rm -fr, etc.
  /\brm\s+(-[^\s]*\s+)*\//,         // rm /path (root-level deletes)
  /\brm\s+-/,                       // rm with any flag (e.g. rm -f, rm -i)
  /\bxargs\s+(-[^\s]*\s+)*rm\b/,
  /\bfind\b.*\s-(delete|exec(dir)?\s+rm)\b/,
  /\bshred\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\s+(-[^\s]*\s+)*[0-7]*0{2}/,  // chmod 000, 700 etc wide perms
  /\bchown\s+-R/,
  /\bchmod\s+-R/,
  />\s*\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk)/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,     // Windows format C:
  /\bnewfs\b/,
  /\bdiskutil\s+erase/,
  /\bsudo\b/,
  /\bgit\s+push\b.*\s(--force|-f\b|\+\S)/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\bgit\s+branch\s+(-[^\s]*\s+)*-D\b/,
  /\bcrontab\s+(-[^\s]*\s+)*-r\b/,
  /\biptables\s+-F/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,  // fork bomb
  /\b(rd|rmdir)\s+(\/[a-z]\s+)*\/s\b/i,         // Windows rd /s
  /\bdel\s+(\S+\s+)*\/[sq]\b/i,                 // Windows del /s, /q
  /\bRemove-Item\b.*\s-Recurse\b/i,
  ...FETCH_AND_EXECUTE,
];

/** Subset of DANGER_PATTERNS that are truly catastrophic */
export const EXTREME_DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\//,  // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  />\s*\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk)/,
  /\bdiskutil\s+erase/,
  /\bformat(\.com)?\s+[a-z]:/i,
  ...FETCH_AND_EXECUTE,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((p) => p.test(cmd));
}

export function isExtremelyDangerous(cmd: string): boolean {
  return EXTREME_DANGER_PATTERNS.some((p) => p.test(cmd));
}
