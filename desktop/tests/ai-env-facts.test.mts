import assert from 'node:assert/strict';
import test from 'node:test';
import { localDateStamp, localOsFromUserAgent, parseOsRelease } from '../src/ai-env-facts.ts';

test('os-release: PRETTY_NAME wins, NAME + VERSION_ID is the fallback', () => {
  assert.equal(parseOsRelease('NAME="Ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"\n'), 'Ubuntu 22.04.4 LTS');
  assert.equal(parseOsRelease("NAME='Alpine Linux'\nVERSION_ID=3.20.1\n"), 'Alpine Linux 3.20.1');
  assert.equal(parseOsRelease('# comment only\n'), null);
  assert.equal(parseOsRelease(''), null);
});

test('local OS comes from the user agent', () => {
  assert.equal(localOsFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macOS');
  assert.equal(localOsFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
  assert.equal(localOsFromUserAgent('something else'), '');
});

test('date stamp is local and names the weekday', () => {
  assert.equal(localDateStamp(new Date(2026, 9, 23, 11, 0)), '2026-10-23 (Friday)');
  assert.equal(localDateStamp(new Date(2027, 0, 3)), '2027-01-03 (Sunday)');
});
