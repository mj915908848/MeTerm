// ─── AI Tools: Meta / Information Tools ─────────────────────────
// web_search (SearXNG), command_help (tldr) and read_output (stored
// command output).
// Non-terminal-interactive tools that fetch information.

import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './themes';
import { queryTldr, formatTldrForAgent } from './tldr-help';
import { ToolHandler } from './ai-tools-core';
import { readStoredOutput, READ_OUTPUT_DEFAULT_LINES } from './ai-output-store';

// ─── web_search (SearXNG) ───────────────────────────────────────

export function createWebSearchTool(): ToolHandler {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web via SearXNG. Use ONLY when: (a) user explicitly asks to search, ' +
        '(b) you encounter an unknown command or error, or (c) you need current/real-time information. ' +
        'IMPORTANT: Always narrow scope with the `sites` parameter when context implies specific sources. Examples:\n' +
        '- Open-source tool / GitHub repo → sites: ["github.com"]\n' +
        '- Python package → sites: ["pypi.org","github.com","stackoverflow.com"]\n' +
        '- npm/node → sites: ["npmjs.com","github.com","stackoverflow.com"]\n' +
        '- Docker → sites: ["hub.docker.com","github.com"]\n' +
        '- Command help → sites: ["man7.org","ss64.com","stackoverflow.com"]\n' +
        '- General/unclear → omit sites',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (concise)' },
          sites: { type: 'string', description: 'Comma-separated domains to restrict results (e.g. "github.com,stackoverflow.com"). Omit for unrestricted.' },
          language: { type: 'string', description: 'Result language code (en, zh, etc.). Default: auto' },
        },
        required: ['query'],
      },
    },
    execute: async (args) => {
      const settings = loadSettings();
      if (!settings.searxngEnabled || !settings.searxngUrl) {
        return 'Web search is not configured. Ask the user to set up SearXNG in Settings > AI.';
      }

      const query = String(args.query ?? '').trim();
      if (!query) return 'Empty search query.';

      // Build query with site filters
      const sitesRaw = String(args.sites ?? '').trim();
      const sites = sitesRaw ? sitesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      let finalQuery = query;
      if (sites.length > 0) {
        finalQuery += ' ' + sites.map(s => `site:${s}`).join(' OR ');
      }

      try {
        const fetchPromise = invoke<{ ok: boolean; status: number; body: string }>('fetch_searxng_search', {
          request: {
            baseUrl: settings.searxngUrl,
            username: settings.searxngUsername,
            query: finalQuery,
            page: 1,
            language: args.language ? String(args.language) : undefined,
          },
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Search request timed out (10s)')), 10_000),
        );
        const resp = await Promise.race([fetchPromise, timeoutPromise]);

        if (!resp.ok) return `Search request failed (HTTP ${resp.status}).`;

        const data = JSON.parse(resp.body);
        let results: { title?: string; url?: string; content?: string }[] = data.results ?? [];

        // Post-filter by domain if sites specified
        if (sites.length > 0) {
          const domains = sites.map(s => s.toLowerCase());
          results = results.filter(r => {
            try {
              const host = new URL(String(r.url)).hostname.toLowerCase();
              return domains.some(d => host === d || host.endsWith('.' + d));
            } catch { return false; }
          });
        }

        results = results.slice(0, 8);
        if (results.length === 0) return 'No results found.';

        return results.map((r, i) => {
          const snippet = (r.content ?? '').slice(0, 200);
          return `[${i + 1}] ${r.title ?? '(no title)'}\n    ${r.url}\n    ${snippet}`;
        }).join('\n\n');
      } catch (e) {
        return `Search error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    // web_search is a network read → safe to parallelize.
    isConcurrencySafe: true,
    // The query leaves the machine, so text the model was steered into
    // (terminal output, file contents) could be sent to the search server.
    // Ask in plan and semi-auto modes; full-auto still runs it.
    requiresConfirm: () => true,
    isDestructive: () => false,
  };
}

// ─── command_help (tldr) ────────────────────────────────────────

export function createCommandHelpTool(): ToolHandler {
  return {
    definition: {
      name: 'command_help',
      description: 'Look up usage examples and documentation for a CLI command using the tldr database. Returns a concise help page with common usage patterns. Use this when you need to recall command syntax or flags.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command name to look up (e.g. "tar", "docker", "ffmpeg")' },
        },
        required: ['command'],
      },
    },
    async execute(args): Promise<string> {
      const cmd = String(args.command ?? '').trim();
      if (!cmd) return 'Error: command name is required.';
      const result = await queryTldr(cmd);
      if (!result.found || !result.page) return `No tldr page found for "${cmd}".`;
      return formatTldrForAgent(result.page);
    },
    // command_help is a pure lookup → safe to parallelize.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,
  };
}

// ─── read_output (stored command output) ────────────────────────

export function createReadOutputTool(): ToolHandler {
  return {
    definition: {
      name: 'read_output',
      description:
        'Read the full text of a run_command / watch_terminal result that was shortened. A shortened result says "Full output saved as \"out-N\"" and which lines were omitted. Pass `offset`/`limit` to read a line range, or `pattern` (case-insensitive regex) to get only the matching lines with their line numbers. Much cheaper than re-running the command.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The saved output id, e.g. "out-3"' },
          offset: { type: 'number', description: 'First line to return, 1-based (default: 1)', minimum: 1 },
          limit: {
            type: 'number',
            description: `Maximum lines to return (default: ${READ_OUTPUT_DEFAULT_LINES})`,
            default: READ_OUTPUT_DEFAULT_LINES,
            minimum: 1,
          },
          pattern: { type: 'string', description: 'Optional regex; when set, returns matching lines instead of a range' },
        },
        required: ['id'],
      },
    },
    async execute(args): Promise<string> {
      const id = String(args.id ?? '').trim();
      if (!id) return 'Error: read_output requires an "id".';
      const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined);
      const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : undefined;
      return readStoredOutput(id, { offset: num(args.offset), limit: num(args.limit), pattern });
    },
    // Pure in-memory lookup → safe to parallelize.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,
  };
}
