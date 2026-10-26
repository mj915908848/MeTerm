// ─── AI Agent: stored command output ───────────────────────────
// run_command / watch_terminal results are capped (TOKEN_BUDGET.
// perToolOutputChars) before they reach the model. Instead of dropping
// the middle for good, the full text is kept here under a short id and
// the truncation note tells the model how to fetch the rest with
// read_output — by line range or by regex.
//
// Import-free so node tests can load it. Memory is bounded by entry
// count and total characters; the oldest outputs go first.

const MAX_ENTRIES = 30;
const MAX_TOTAL_CHARS = 4 * 1024 * 1024;
/** Default number of lines read_output returns. */
export const READ_OUTPUT_DEFAULT_LINES = 100;
const MAX_PATTERN_MATCHES = 100;
const MAX_LINE_CHARS = 500;
/** Most characters one read_output result returns, whatever the line count. */
const MAX_RESULT_CHARS = 16000;

const store = new Map<string, string>();
let totalChars = 0;
let nextId = 1;
// Outputs live in memory only, but their ids stay in saved conversations.
// A per-launch tag keeps an id from an earlier launch from naming a new,
// unrelated output after a restart.
const launchTag = Math.random().toString(36).slice(2, 6).padEnd(4, '0');

/** Keep `text` and return its id. */
export function saveOutput(text: string): string {
  const id = `out-${launchTag}-${nextId++}`;
  store.set(id, text);
  totalChars += text.length;
  for (const [oldId, old] of store) {
    if (store.size <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) break;
    if (oldId === id) break;
    store.delete(oldId);
    totalChars -= old.length;
  }
  return id;
}

/** Test hook: forget everything. */
export function clearStoredOutputs(): void {
  store.clear();
  totalChars = 0;
}

/**
 * Cap `text` at about `maxChars` for the model. Keeps whole lines from
 * the start (one third) and the end (two thirds — errors and summaries
 * usually come last); when anything is cut, the full text is saved and
 * the gap names the omitted lines and how to read them.
 */
export function truncateWithRecall(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const headBudget = Math.floor(maxChars / 3);
  const tailBudget = maxChars - headBudget;

  let headEnd = 0;
  let used = 0;
  while (headEnd < lines.length && used + lines[headEnd].length + 1 <= headBudget) {
    used += lines[headEnd].length + 1;
    headEnd++;
  }
  let tailStart = lines.length;
  used = 0;
  while (tailStart > headEnd && used + lines[tailStart - 1].length + 1 <= tailBudget) {
    used += lines[tailStart - 1].length + 1;
    tailStart--;
  }

  const id = saveOutput(text);
  // A few very long lines can leave nothing whole on one side; fall back
  // to a character cut there so the model still sees something.
  const head = headEnd > 0 ? lines.slice(0, headEnd).join('\n') : text.slice(0, headBudget);
  const tail = tailStart < lines.length ? lines.slice(tailStart).join('\n') : text.slice(-tailBudget);
  const from = headEnd + 1;
  const to = tailStart;
  const gap = from <= to
    ? `lines ${from}-${to} of ${lines.length} omitted`
    : `output of ${lines.length} lines shortened`;
  return `${head}\n\n... [${gap}. Full output saved as "${id}": read_output({id: "${id}", offset: ${Math.min(from, lines.length)}}) reads on, read_output({id: "${id}", pattern: "error|fail"}) searches it.] ...\n\n${tail}`;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** read_output body: a line range, or the lines matching `pattern`. */
export function readStoredOutput(
  id: string,
  opts: { offset?: number; limit?: number; pattern?: string },
): string {
  const text = store.get(id);
  if (text === undefined) {
    return `Error: no stored output "${id}". Stored outputs are kept in memory for the most recent ${MAX_ENTRIES} truncated results of this app session only (they do not survive a restart); re-run the command, ideally with a filter (grep, tail).`;
  }
  const lines = text.split('\n');
  const limit = opts.limit ?? READ_OUTPUT_DEFAULT_LINES;

  if (opts.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, 'i');
    } catch (e) {
      return `Error: invalid pattern: ${e instanceof Error ? e.message : String(e)}`;
    }
    const hits: string[] = [];
    let count = 0;
    let used = 0;
    let full = false;
    lines.forEach((line, i) => {
      if (!re.test(line)) return;
      count++;
      if (full || hits.length >= Math.min(limit, MAX_PATTERN_MATCHES)) return;
      const hit = `${i + 1}: ${clip(line)}`;
      if (hits.length > 0 && used + hit.length + 1 > MAX_RESULT_CHARS) {
        full = true;
        return;
      }
      hits.push(hit);
      used += hit.length + 1;
    });
    if (count === 0) return `No lines in "${id}" (${lines.length} lines) match /${opts.pattern}/i.`;
    const more = count > hits.length ? `\n--- ${count - hits.length} more matches not shown; narrow the pattern. ---` : '';
    return `${hits.join('\n')}${more}`;
  }

  const start = Math.max(1, opts.offset ?? 1);
  if (start > lines.length) return `"${id}" has only ${lines.length} lines.`;
  let end = Math.min(lines.length, start + limit - 1);
  const kept: string[] = [];
  let used = 0;
  for (let i = start - 1; i < end; i++) {
    const line = clip(lines[i]);
    if (kept.length > 0 && used + line.length + 1 > MAX_RESULT_CHARS) {
      end = i;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const body = kept.join('\n');
  const more = end < lines.length ? ` Next: offset=${end + 1}.` : '';
  return `${body}\n\n--- "${id}" lines ${start}-${end} of ${lines.length}.${more} ---`;
}
