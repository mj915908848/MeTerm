/**
 * The connect payload a JumpServer asset-browser window hands to the main window.
 *
 * The account endpoint does not report `privileged`, so the window used to send
 * `undefined`; JSON serialization drops such a key, and the owner's validator —
 * which required a boolean — then rejected the whole event. Every "连接" from that
 * window failed while the side panel, which calls the same handler directly and
 * never crosses the window boundary, worked. That asymmetry is what the two
 * constants below have to keep in step: the sender has to produce a boolean, and
 * the receiver has to accept its absence, or the same dead end comes back from
 * either side alone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** Slice a top-level function out of a module, from its signature to its brace. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

test('the browser window sends a boolean the owner validator can accept', () => {
  const source = read('jumpserver-browser-window.ts');
  const start = source.indexOf("await forwardBrowserEvent('jumpserver-connect-asset'");
  assert.ok(start > 0, 'the connect event was not found');
  const payload = source.slice(start, source.indexOf('});', start));
  assert.ok(
    payload.includes('privileged: account.privileged === true'),
    'privileged must be coerced to a boolean, or the key is dropped and the event refused',
  );
});

test('the owner validator treats a missing privileged flag as valid', () => {
  const rust = fs.readFileSync(
    new URL('../src-tauri/src/commands/jumpserver_browser.rs', import.meta.url),
    'utf8',
  );
  const body = fnBody(rust, 'fn validate_connect_asset(');
  assert.ok(
    body.includes('optional_safe_bool(account.get("privileged"))'),
    'a missing privileged flag must not reject the asset connection',
  );
  assert.ok(
    !body.includes('as_bool().is_some()'),
    'requiring the flag present is exactly what broke connecting from this window',
  );
});
