// ─── AI Tools: save_host_note ──────────────────────────────────
// Lets the agent keep durable facts about a host for later runs (see
// ai-host-notes.ts). Every save goes through the approval card unless
// the user runs in full-auto, because whatever is saved is shown to the
// model again on every later run against that host.

import { ToolHandler, resolvePaneTarget } from './ai-tools-core';
import {
  appendedHostNotes,
  getHostNotes,
  hostNotesKey,
  HOST_NOTES_MAX_CHARS,
  LOCAL_HOST_KEY,
  setHostNotes,
  toBullets,
} from './ai-host-notes';

export function createSaveHostNoteTool(): ToolHandler {
  return {
    definition: {
      name: 'save_host_note',
      description:
        'Save a durable fact about the host of a pane so you see it again in later conversations about that host: where an app or its config lives, how it is deployed or restarted, ports, versions, quirks you had to work around. ' +
        'Write ONE fact per line, each short (aim for under ~100 characters), e.g. "sshd config: /etc/ssh/sshd_config + drop-ins in sshd_config.d/" — not one long paragraph; every line becomes its own bullet. ' +
        'mode "append" (default) adds the lines to the existing notes; mode "replace" overwrites all notes for the host — use it to correct or condense outdated notes. ' +
        `Limit ${HOST_NOTES_MAX_CHARS} characters per host. NEVER save passwords, tokens, keys or other secrets.`,
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'One short fact per line: the lines to add (append) or the full new notes (replace)' },
          mode: { type: 'string', description: '"append" (default) or "replace"' },
          pane: {
            type: 'number',
            description: 'Optional pane number whose host the note is about. Omit for the default target.',
          },
        },
        required: ['note'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => true,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const mode = args.mode === undefined || args.mode === '' ? 'append' : String(args.mode);
      if (mode !== 'append' && mode !== 'replace') {
        return 'Error: mode must be "append" or "replace".';
      }
      if (!note && mode === 'append') return 'Error: save_host_note requires a non-empty "note".';
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const key = hostNotesKey(target.pane.isSSH, target.pane.serverInfo);
      if (!key) return 'Error: the host of this pane is unknown, so notes cannot be saved for it.';
      const next = mode === 'replace' ? toBullets(note).join('\n') : appendedHostNotes(getHostNotes(key), note);
      try {
        setHostNotes(key, next);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}. Condense the notes and save them with mode "replace".`;
      }
      const host = key === LOCAL_HOST_KEY ? 'this computer' : key;
      return next
        ? `Saved notes for ${host} (${next.length}/${HOST_NOTES_MAX_CHARS} characters).`
        : `Cleared the notes for ${host}.`;
    },
  };
}
