import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { headCommit, newestSource, buildStamp, isStale, stampLine } from '../build-stamp.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
}

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('reads a loose ref through a symbolic HEAD', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), SHA + '\n');

  assert.deepEqual(headCommit(dir), { sha: SHA, branch: 'main' });
});

test('reads a branch whose only ref is packed', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(dir, '.git', 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/tags/v1\n^${SHA}\n${SHA} refs/heads/main\n`,
  );

  // The peel line under the tag must not be mistaken for the branch's sha.
  assert.deepEqual(headCommit(dir), { sha: SHA, branch: 'main' });
});

test('reads a detached HEAD', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), SHA + '\n');

  assert.deepEqual(headCommit(dir), { sha: SHA, branch: null });
});

test('follows a worktree .git file to the real git directory', () => {
  const real = tmpdir();
  fs.mkdirSync(path.join(real, 'worktrees', 'lane'), { recursive: true });
  fs.writeFileSync(path.join(real, 'worktrees', 'lane', 'HEAD'), SHA + '\n');

  const work = tmpdir();
  fs.writeFileSync(path.join(work, '.git'), `gitdir: ${path.join(real, 'worktrees', 'lane')}\n`);

  assert.deepEqual(headCommit(work), { sha: SHA, branch: null });
});

test('a directory with no repository stamps as unknown rather than throwing', () => {
  const dir = tmpdir();
  assert.equal(headCommit(dir), null);

  const stamp = buildStamp(dir);
  assert.equal(stamp.commit, null);
  assert.equal(stamp.branch, null);
  assert.equal(stampLine(stamp), 'running unknown commit');
});

test('the banner names the branch and short sha', () => {
  assert.equal(stampLine({ commit: '377aa7a', branch: 'main' }), 'running main 377aa7a');
  assert.equal(stampLine({ commit: '377aa7a', branch: null }), 'running 377aa7a');
});

test('newestSource looks only at top-level .mjs files', () => {
  const dir = tmpdir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'serve.mjs'), '');
  fs.utimesSync(path.join(dir, 'serve.mjs'), now / 1000, (now - 10_000) / 1000);
  fs.writeFileSync(path.join(dir, 'notes.md'), '');
  fs.utimesSync(path.join(dir, 'notes.md'), now / 1000, now / 1000);
  fs.mkdirSync(path.join(dir, 'fixtures'));
  fs.writeFileSync(path.join(dir, 'fixtures', 'later.mjs'), '');

  // A newer markdown file and a newer fixture must not out-rank the source:
  // touching either says nothing about whether the server is stale.
  assert.equal(newestSource(dir, now + 1000).file, 'serve.mjs');
});

test('a file stamped in the future is ignored, not treated as newest', () => {
  const dir = tmpdir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'ok.mjs'), '');
  fs.utimesSync(path.join(dir, 'ok.mjs'), now / 1000, (now - 5000) / 1000);
  fs.writeFileSync(path.join(dir, 'skewed.mjs'), '');
  fs.utimesSync(path.join(dir, 'skewed.mjs'), now / 1000, (now + 3_600_000) / 1000);

  assert.equal(newestSource(dir, now).file, 'ok.mjs');
});

test('a source edited after boot reads as stale, and names the file', () => {
  const dir = tmpdir();
  const boot = Date.now();
  fs.writeFileSync(path.join(dir, 'map-view.mjs'), '');
  fs.utimesSync(path.join(dir, 'map-view.mjs'), boot / 1000, (boot + 60_000) / 1000);

  const stale = isStale({ startedAt: boot }, dir, boot + 120_000);
  assert.equal(stale.stale, true);
  assert.equal(stale.file, 'map-view.mjs');
});

test('a source written just before boot is not stale', () => {
  const dir = tmpdir();
  const boot = Date.now();
  fs.writeFileSync(path.join(dir, 'map-view.mjs'), '');
  fs.utimesSync(path.join(dir, 'map-view.mjs'), boot / 1000, (boot - 1000) / 1000);

  assert.equal(isStale({ startedAt: boot }, dir, boot + 1000).stale, false);
});

test('a pull landing in the same second as the restart does not cry wolf', () => {
  const dir = tmpdir();
  const boot = Date.now();
  fs.writeFileSync(path.join(dir, 'map-view.mjs'), '');
  fs.utimesSync(path.join(dir, 'map-view.mjs'), boot / 1000, (boot + 400) / 1000);

  assert.equal(isStale({ startedAt: boot }, dir, boot + 5000).stale, false);
});

test('no sources at all is not stale', () => {
  const dir = tmpdir();
  assert.deepEqual(isStale({ startedAt: Date.now() }, dir), { stale: false, file: null, mtime: null });
});

test('the real checkout stamps with a commit', () => {
  const repo = path.dirname(new URL('.', import.meta.url).pathname);
  const stamp = buildStamp(repo);
  assert.match(stamp.commit, /^[0-9a-f]{7}$/);
  assert.equal(typeof stamp.newestSource, 'string');
});
