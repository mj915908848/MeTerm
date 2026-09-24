import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const buildDmg = fileURLToPath(new URL('../scripts/build-dmg.sh', import.meta.url));

test('DMG build rejects invalid app signatures and accepts valid ones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meterm-dmg-test-'));
  try {
    const app = path.join(root, 'MeTerm.app');
    const fakeBin = path.join(root, 'bin');
    const payload = path.join(root, 'payload');
    await mkdir(path.join(app, 'Contents', '_CodeSignature'), { recursive: true });
    await writeFile(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
    await mkdir(fakeBin);
    await writeFile(path.join(fakeBin, 'ditto'), '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });
    await writeFile(path.join(fakeBin, 'codesign'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(path.join(fakeBin, 'hdiutil'), `#!/bin/sh
case "$1" in
  create)
    src=''
    prev=''
    for arg in "$@"; do
      if [ "$prev" = '-srcfolder' ]; then src="$arg"; fi
      prev="$arg"
      output="$arg"
    done
    mkdir -p "$FAKE_DMG_PAYLOAD"
    cp -R "$src"/. "$FAKE_DMG_PAYLOAD"/
    : > "$output"
    ;;
  attach)
    prev=''
    for arg in "$@"; do
      if [ "$prev" = '-mountpoint' ]; then mount="$arg"; fi
      prev="$arg"
    done
    cp -R "$FAKE_DMG_PAYLOAD"/. "$mount"/
    ;;
  detach) exit 0 ;;
esac
`, { mode: 0o755 });

    let failure: unknown;
    try {
      await execFileAsync('bash', [buildDmg, app, path.join(root, 'output.dmg'), 'MeTerm'], {
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_DMG_PAYLOAD: payload },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'an invalid packaged app signature must fail the build');
    assert.match(String((failure as { stdout?: string }).stdout), /签名校验未通过/);

    // The failure gate must still allow the free ad-hoc signing path when
    // the packaged app passes codesign verification.
    await writeFile(path.join(fakeBin, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const valid = await execFileAsync('bash', [buildDmg, app, path.join(root, 'valid.dmg'), 'MeTerm'], {
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_DMG_PAYLOAD: payload },
    });
    assert.match(valid.stdout, /打包完成/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
