/** Shell exit 130 means SIGINT, not successful command completion. */
export function isTerminalInterruption(tool: string, result: string): boolean {
  return (tool === 'run_command' || tool === 'watch_terminal') &&
    /\[status: completed,[^\]\n]*\bexit: 130(?:,|\])/.test(result);
}
