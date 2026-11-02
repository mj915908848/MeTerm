import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Load ai-capsule-markdown.ts with its two imports stubbed (i18n pulls in the DOM).
const source = readFileSync(new URL('../src/ai-capsule-markdown.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText;
const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const stubs: Record<string, unknown> = {
  './status-bar': { escapeHtml: (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]) },
  './i18n': { t: (k: string) => k },
};
const mod = { exports: {} as Record<string, any> };
new Function('require', 'module', 'exports', js)((id: string) => stubs[id], mod, mod.exports);
const { renderMarkdown, renderInlineMarkdown, renderInline } = mod.exports;
const md = (text: string, opts = {}) => renderMarkdown(text, 's1', () => {}, opts);

test('code fence accepts info strings with symbols and trailing spaces', () => {
  const cpp = md('```c++\nint main() {}\nreturn 0;\n```');
  assert.match(cpp, /ai-cmd-lang">c\+\+</);
  assert.doesNotMatch(cpp.split('ai-response-actions')[0], /```/);
  const spaced = md('```bash \necho a\necho b\n```');
  assert.match(spaced, /ai-cmd-lang">bash</);
  assert.match(spaced, /ai-cmd-run/);
});

test('streaming: unclosed fence renders as code, no action buttons', () => {
  const html = md('Run this:\n```bash\napt update\napt upgr', { streaming: true });
  assert.match(html, /<pre><code>apt update\napt upgr<\/code><\/pre>/);
  assert.doesNotMatch(html, /```/);
  assert.doesNotMatch(html, /ai-cmd-run|ai-cmd-copy|ai-response-copy/);
  // Fence marker alone (no newline yet) is not leaked either.
  assert.doesNotMatch(md('text\n```', { streaming: true }), /```/);
});

test('final render keeps copy buttons', () => {
  assert.match(md('hello'), /ai-response-copy/);
});

test('ordered, nested and blank-separated lists', () => {
  const html = renderInlineMarkdown('1. one\n2. two\n   - sub\n3. three');
  assert.equal(html, '<ol class="ai-md-list ai-md-olist"><li>one</li><li>two<ul class="ai-md-list"><li>sub</li></ul></li><li>three</li></ol>');
  const start = renderInlineMarkdown('3. c\n\n4. d');
  assert.equal(start, '<ol class="ai-md-list ai-md-olist" start="3"><li>c</li><li>d</li></ol>');
});

test('headings to level 6 and blockquotes', () => {
  assert.equal(renderInlineMarkdown('#### Four'), '<h4 class="ai-md-h4">Four</h4>');
  assert.equal(renderInlineMarkdown('> quoted **bold**\n> more'), '<blockquote class="ai-md-quote"><p>quoted <strong>bold</strong><br>more</p></blockquote>');
});

test('inline: code spans are not formatted, links only for http(s)', () => {
  assert.equal(renderInline('`a **b** c`'), '<code class="ai-inline-code">a **b** c</code>');
  assert.equal(renderInline('*it* and _it_ and ~~x~~'), '<em>it</em> and <em>it</em> and <del>x</del>');
  assert.equal(renderInline('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
  assert.match(renderInline('[docs](https://example.com/a_b)'), /<a class="ai-md-link" href="https:\/\/example.com\/a_b"[^>]*>docs<\/a>/);
  assert.doesNotMatch(renderInline('[x](javascript:alert(1))'), /<a /);
  assert.match(renderInline('see https://example.com/x.'), /href="https:\/\/example.com\/x"/);
});

test('escaped html stays escaped', () => {
  assert.doesNotMatch(renderInlineMarkdown('<img src=x onerror=alert(1)>'), /<img/);
});
