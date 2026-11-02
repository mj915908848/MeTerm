import { escapeHtml } from './status-bar';
import { t } from './i18n';

export interface RenderMarkdownOptions {
  /** Show the "Run" button on shell code blocks (default true). */
  allowRun?: boolean;
  /**
   * Live preview while a reply is still streaming: no action buttons
   * (they would be thrown away by the next frame) and an unclosed code
   * fence at the end is shown as a code block instead of raw backticks.
   */
  streaming?: boolean;
}

/** Fence opener: ``` plus an optional info string (`bash`, `c++`, `objective-c title=x`). */
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function fenceLang(info: string): string {
  return info.trim().split(/\s+/)[0] ?? '';
}

export function renderMarkdown(text: string, sessionId: string, addHistoryFn: (cmd: string) => void, options: RenderMarkdownOptions = {}): string {
  const streaming = options.streaming === true;
  const segments: string[] = [];
  const codeBlockRegex = new RegExp(FENCE_RE.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushCode = (lang: string, rawCode: string): void => {
    const code = streaming ? rawCode.replace(/\s+$/, '') : rawCode.trim();
    const isBash = /^(bash|sh|shell|zsh|fish|cmd|powershell|console|shellscript)?$/i.test(lang);

    // Single-line: no newlines and short enough to fit on one row
    const isInline = !code.includes('\n') && code.length <= 65 && !streaming;

    // Generate a unique id for command execution binding
    const blockId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    segments.push(
      `<div class="ai-cmd-block ${isInline ? 'ai-cmd-inline' : 'ai-cmd-stacked'}" data-block-id="${blockId}">` +
      `<div class="ai-cmd-screen">` +
      (!isInline ? `<div class="ai-cmd-lang">${escapeHtml(lang || 'code')}</div>` : '') +
      `<pre><code>${escapeHtml(code)}</code></pre>` +
      `</div>` +
      (streaming ? '' :
        `<div class="ai-cmd-actions">` +
        (isBash && options.allowRun !== false
          ? `<button class="ai-cmd-run" data-cmd="${escapeHtml(code)}" data-session="${sessionId}">${t('aiRunCommand')}</button>`
          : '') +
        `<button class="ai-cmd-copy" data-code="${escapeHtml(code)}">${t('aiCopyCode')}</button>` +
        `</div>`) +
      `</div>`
    );
  };

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      segments.push(renderInlineMarkdown(text.slice(lastIndex, match.index)));
    }
    pushCode(fenceLang(match[1]), match[2]);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block. While streaming, a fence that
  // has opened but not yet closed is rendered as a (growing) code block.
  let rest = text.slice(lastIndex);
  if (streaming) {
    const open = /```([^\n`]*)(?:\n([\s\S]*))?$/.exec(rest);
    if (open) {
      if (open.index > 0) segments.push(renderInlineMarkdown(rest.slice(0, open.index)));
      pushCode(fenceLang(open[1]), open[2] ?? '');
      rest = '';
    }
  }
  if (rest) {
    segments.push(renderInlineMarkdown(rest));
  }

  return segments.join('') + (text && !streaming ?
    `<div class="ai-response-actions"><button type="button" class="ai-response-copy" data-code="${escapeHtml(text)}" aria-label="${t('aiCopyResponse')}">${t('aiCopyResponse')}</button></div>` : '');
}

/**
 * Block-level markdown renderer using a line-based state machine.
 *
 * Why a state machine and not split-on-blank-lines?  LLMs frequently
 * emit a markdown table flush against the surrounding paragraph
 * (no blank line above the table) — the previous implementation
 * required `\n\n` to start a fresh block, which meant the whole
 * paragraph + table got bundled into one block where lines[0] was
 * a sentence, not a table header, so the table heuristic missed.
 *
 * Now we walk the input line-by-line and recognize:
 *   • headings (#, ##, ###)
 *   • horizontal rules (---, ***, ___)
 *   • unordered lists (-, *, +)
 *   • GitHub-flavored markdown tables (pipes + separator row)
 *   • blank lines (close any open paragraph or list)
 *   • everything else accumulated into a paragraph
 *
 * Tables are detected by looking ahead one line: if the current
 * line contains a pipe AND the next line is a valid separator
 * (`---`/`:---:` segments joined by pipes), we enter table mode.
 */
export function renderInlineMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  // Open lists, outermost first. `indent` is the marker's column, so a
  // deeper-indented item opens a nested list and a shallower one closes it.
  const lists: Array<{ tag: 'ul' | 'ol'; indent: number }> = [];
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push(`<p>${paraBuf.join('<br>')}</p>`);
    paraBuf = [];
  };
  const closeListsTo = (depth: number) => {
    while (lists.length > depth) {
      out.push(`</li></${lists.pop()!.tag}>`);
    }
  };
  const closeList = () => closeListsTo(0);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lt = line.trim();

    // ── Blank line: end paragraph; a list survives one blank line when
    //    the next line continues it (LLMs often put blanks between items).
    if (!lt) {
      flushPara();
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      if (!next || !LIST_ITEM_RE.test(next)) closeList();
      i++;
      continue;
    }

    // ── Table: current line has pipes AND next line is a separator ──
    if (
      i + 1 < lines.length &&
      lt.includes('|') &&
      isTableSeparator(lines[i + 1])
    ) {
      flushPara();
      closeList();
      const tableLines: string[] = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length) {
        const lj = lines[j].trim();
        if (!lj || !lj.includes('|')) break;
        tableLines.push(lines[j]);
        j++;
      }
      out.push(renderTable(tableLines));
      i = j;
      continue;
    }

    // ── Horizontal rule (must NOT also be a hijacked table separator) ──
    if (/^---+$/.test(lt) || /^\*\*\*+$/.test(lt) || /^___+$/.test(lt)) {
      flushPara();
      closeList();
      out.push('<hr class="ai-md-hr">');
      i++;
      continue;
    }

    // ── Headings (# … ######) ──
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(lt);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      // Chat bubbles are small: # → h2, ## → h3, ### and deeper → h4.
      const tag = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4';
      const cls = level === 1 ? 'ai-md-h1' : level === 2 ? 'ai-md-h2' : level === 3 ? 'ai-md-h3' : 'ai-md-h4';
      out.push(`<${tag} class="${cls}">${renderInline(escapeHtml(heading[2]))}</${tag}>`);
      i++;
      continue;
    }

    // ── Blockquote: consecutive `>` lines, rendered recursively ──
    if (lt.startsWith('>')) {
      flushPara();
      closeList();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="ai-md-quote">${renderInlineMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    // ── Lists: `- x`, `* x`, `+ x`, `1. x`, `1) x`, nested by indentation ──
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      const ordered = /\d/.test(item[2]);
      const tag: 'ul' | 'ol' = ordered ? 'ol' : 'ul';
      // Close lists nested deeper than this item.
      while (lists.length > 0 && indent < lists[lists.length - 1].indent) {
        out.push(`</li></${lists.pop()!.tag}>`);
      }
      const top = lists[lists.length - 1];
      if (top && indent >= top.indent + 2) {
        // Deeper than the current item → nested list inside it.
        lists.push({ tag, indent });
        out.push(listOpen(tag, item[2]));
      } else if (top && top.tag === tag) {
        out.push('</li>');
      } else {
        if (top) out.push(`</li></${lists.pop()!.tag}>`);
        lists.push({ tag, indent });
        out.push(listOpen(tag, item[2]));
      }
      out.push(`<li>${renderInline(escapeHtml(item[3]))}`);
      i++;
      continue;
    }

    // ── Indented continuation of a list item ──
    if (lists.length > 0 && /^\s{2,}\S/.test(line)) {
      out.push(`<br>${renderInline(escapeHtml(lt))}`);
      i++;
      continue;
    }

    // ── Regular text → buffer for paragraph ──
    closeList();
    paraBuf.push(renderInline(escapeHtml(lt)));
    i++;
  }
  flushPara();
  closeList();
  return out.join('');
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function listOpen(tag: 'ul' | 'ol', marker: string): string {
  if (tag === 'ul') return '<ul class="ai-md-list">';
  const start = parseInt(marker, 10);
  return `<ol class="ai-md-list ai-md-olist"${start > 1 ? ` start="${start}"` : ''}>`;
}

/**
 * Does a line look like a GFM table separator row?
 * Examples that should match:
 *   |---|---|         (canonical)
 *   |:--|:-:|--:|     (left / center / right alignment)
 *   ---|---|---       (no outer pipes)
 *   | -- | -- |       (only 2 dashes — common LLM output)
 *
 * Examples that should NOT match:
 *   ---               (horizontal rule)
 *   text---more       (in-paragraph dashes)
 */
function isTableSeparator(line: string): boolean {
  let t = line.trim();
  if (!t) return false;
  // Must contain a pipe somewhere — otherwise it's a horizontal rule.
  if (!t.includes('|')) return false;
  // Strip optional outer pipes.
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const segments = t.split('|').map((s) => s.trim());
  if (segments.length === 0) return false;
  // Each segment: optional leading colon, two-or-more dashes, optional trailing colon.
  return segments.every((s) => /^:?-{2,}:?$/.test(s));
}

/** Parse a markdown table row, tolerating optional outer pipes. */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Parse the alignment row (`|:---|---:|:---:|`) into per-column hints.
 * Returns one of 'left' | 'right' | 'center' | undefined for each column.
 */
function parseAlignments(line: string): Array<'left' | 'right' | 'center' | undefined> {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((seg) => {
    const s = seg.trim();
    const startsColon = s.startsWith(':');
    const endsColon = s.endsWith(':');
    if (startsColon && endsColon) return 'center';
    if (endsColon) return 'right';
    if (startsColon) return 'left';
    return undefined;
  });
}

/** Render a markdown table from its raw line array. */
function renderTable(lines: string[]): string {
  const headers = parseRow(lines[0]);
  const aligns = parseAlignments(lines[1]);
  const rows = lines.slice(2).filter((l) => l.trim().includes('|')).map(parseRow);

  const styleFor = (i: number): string => {
    const a = aligns[i];
    return a ? ` style="text-align:${a}"` : '';
  };

  let html = '<table class="ai-md-table"><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    html += `<th${styleFor(i)}>${renderInline(escapeHtml(headers[i]))}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      html += `<td${styleFor(i)}>${renderInline(escapeHtml(row[i] ?? ''))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

/**
 * Render inline markdown on already-escaped text: `code`, [links](https://…),
 * bare https:// URLs, **bold**, *italic*, ~~strike~~. Code spans are pulled
 * out first so nothing inside them is formatted.
 */
export function renderInline(html: string): string {
  const stash: string[] = [];
  const keep = (frag: string): string => `\u0000${stash.push(frag) - 1}\u0000`;

  html = html.replace(/`([^`]+)`/g, (_m, code: string) => keep(`<code class="ai-inline-code">${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    keep(`<a class="ai-md-link" href="${url}" title="${url}">${label}</a>`));
  html = html.replace(/(^|[\s(（])(https?:\/\/[^\s<）)]*[^\s<）).,;:!?。，；：！？'"])/g, (_m, pre: string, url: string) =>
    pre + keep(`<a class="ai-md-link" href="${url}" title="${url}">${url}</a>`));
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^\w])__(.+?)__(?!\w)/g, '$1<strong>$2</strong>');
  html = html.replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => stash[Number(n)]);
}
