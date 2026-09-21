/**
 * The connection dialogs no longer dim what is behind them.
 *
 * Editing a connection happens in the connections window, right on top of the
 * list the user is working in — greying that list out is pure loss. The darkening
 * also had to go in every other window (the main window's SSH/JumpServer dialogs
 * reuse the same overlay class), so these guards are about the class, not a
 * window.
 *
 * What must NOT change: the overlay element itself. It is what catches a click
 * outside the dialog, and what the Escape handler checks for before dismissing —
 * dropping it would leave the dialog un-closable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const STYLES = new URL('../src/styles/', import.meta.url);
const readSource = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** The three overlays the connection dialogs mount. */
const OVERLAYS = ['ssh-modal-overlay', 'remote-modal-overlay', 'js-asset-browser-overlay'];

/** Every `selector { body }` rule in a stylesheet. */
function* rules(css: string): Generator<{ selector: string; body: string }> {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    yield { selector: match[1], body: match[2] };
  }
}

/**
 * Whether the rule's *subject* (the rightmost compound of each comma part) is the
 * overlay. Deliberately not a substring test: `.ssh-modal-overlay .ssh-modal {
 * background: … }` styles the dialog, not the scrim, and must not be flagged.
 */
function targetsOverlay(selector: string, cls: string): boolean {
  return selector.split(',').some((part) => {
    const subject = part.trim().split(/\s+/).pop() ?? '';
    return subject.split('.').includes(cls);
  });
}

test('no stylesheet dims a connection dialog overlay', () => {
  const offenders: string[] = [];
  // Sanity check against a vacuous pass: if the subject detection broke, the scan
  // would simply find nothing and the guard would go green while dimming returned.
  const seen = new Map(OVERLAYS.map((overlay) => [overlay, 0]));

  for (const file of fs.readdirSync(STYLES)) {
    if (!file.endsWith('.css')) continue;
    const css = fs.readFileSync(new URL(file, STYLES), 'utf8');
    for (const { selector, body } of rules(css)) {
      for (const overlay of OVERLAYS) {
        if (!targetsOverlay(selector, overlay)) continue;
        seen.set(overlay, seen.get(overlay)! + 1);
        if (/background\s*:/.test(body) || /backdrop-filter\s*:/.test(body)) {
          offenders.push(`${file}: ${selector.trim()} {${body.trim()}}`);
        }
      }
    }
  }

  for (const [overlay, count] of seen) {
    assert.ok(count > 0, `.${overlay} is never styled anywhere — the scan is broken, not the CSS`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these rules dim a connection dialog's overlay again:\n  ${offenders.join('\n  ')}`,
  );
});

test('the overlays still exist, so the dialogs stay dismissable', () => {
  // The SSH dialog and every JumpServer dialog share this class.
  const ssh = readSource('ssh.ts');
  assert.match(ssh, /overlay\.className = 'ssh-modal-overlay'/, 'the SSH overlay was removed');
  assert.ok(
    ssh.includes('e.target === overlay'),
    'the click-outside handler was removed, so the dialog could not be dismissed',
  );

  assert.match(
    readSource('remote.ts'),
    /overlay\.className = 'remote-modal-overlay'/,
    'the remote overlay was removed',
  );
  assert.match(
    readSource('jumpserver-ui.ts'),
    /overlay\.className = 'ssh-modal-overlay'/,
    'the JumpServer dialogs rely on the shared SSH overlay class',
  );
});

test('dropping the scrim did not take the dialog surface with it', () => {
  // Without a scrim the dialog is the only thing separating itself from the list,
  // so its own surface + shadow must stay.
  const sshCss = fs.readFileSync(new URL('ssh-modal.css', STYLES), 'utf8');
  const modal = [...rules(sshCss)].find(({ selector }) => targetsOverlay(selector, 'ssh-modal'));
  assert.ok(modal, 'the .ssh-modal rule was not found');
  assert.match(modal.body, /background\s*:/, 'the dialog needs its own opaque surface');
  assert.match(modal.body, /box-shadow\s*:/, 'the dialog needs its own shadow to float above the list');
});
