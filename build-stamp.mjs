/**
 * build-stamp.mjs — answering "is the server actually running my code?"
 *
 * serve.mjs imports every page module once, at startup, and builds each page
 * from template literals held in memory. That is fast and it is why the pages
 * have no build step — but it also means a `git pull` changes nothing until
 * the process is restarted. A server left running from yesterday serves
 * yesterday's HTML forever, with no error and nothing in the page to say so,
 * and the symptom is a feature that exists in the repository and is missing
 * from the browser.
 *
 * That has now cost a round trip, so the server says which code it is running:
 * the commit at startup, and — more usefully — whether any source file on disk
 * is NEWER than the moment the process started. The second one catches the
 * case the commit hash cannot: pulled, edited, or checked out a branch, and
 * never restarted.
 *
 * Everything here is best-effort. A missing .git, a worktree, a tarball with
 * no repository at all: the stamp degrades to "unknown" and the server starts
 * normally. Refusing to boot because we could not read a hash would be worse
 * than the problem.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The commit HEAD points at, read from the filesystem rather than by shelling
 * out to git — a spawn per boot for one hash, on a machine that may not have
 * git on PATH, is not worth it.
 *
 * Handles the three shapes .git/HEAD comes in: a symbolic ref to a loose ref
 * file, a symbolic ref whose target only exists in packed-refs (a fresh clone
 * that has never written a loose ref), and a detached HEAD holding a raw sha.
 * A worktree's .git is a FILE pointing at the real directory; that is followed
 * too, since worktrees are how this project runs parallel lanes.
 */
export function headCommit(repoDir) {
  try {
    let gitDir = path.join(repoDir, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      // "gitdir: /abs/or/relative/path"
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!m) return null;
      gitDir = path.resolve(repoDir, m[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return /^[0-9a-f]{40}$/i.test(head) ? { sha: head, branch: null } : null;

    const branch = ref[1].replace(/^refs\/heads\//, '');
    const loose = path.join(gitDir, ref[1]);
    if (fs.existsSync(loose)) {
      return { sha: fs.readFileSync(loose, 'utf8').trim(), branch };
    }
    // Fall back to packed-refs: "<sha> <refname>" lines, plus comments and
    // "^<sha>" peel lines for tags, which are not refs and must be skipped.
    const packed = path.join(gitDir, 'packed-refs');
    if (!fs.existsSync(packed)) return { sha: null, branch };
    for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref[1]) return { sha, branch };
    }
    return { sha: null, branch };
  } catch (err) {
    return null;
  }
}

/**
 * The newest modification time among the server's own source files, and which
 * file it was. Only top-level .mjs files are considered: those are what
 * serve.mjs imports, and walking the whole tree would let a touched fixture or
 * a rewritten database claim the server is stale when it is not.
 */
export function newestSource(repoDir, now = Date.now()) {
  let newest = { file: null, mtime: 0 };
  let entries;
  try {
    entries = fs.readdirSync(repoDir);
  } catch (err) {
    return newest;
  }
  for (const name of entries) {
    if (!name.endsWith('.mjs')) continue;
    let st;
    try { st = fs.statSync(path.join(repoDir, name)); } catch (err) { continue; }
    if (!st.isFile()) continue;
    // A clock skew or a bad archive can stamp a file in the future, which
    // would read as permanently stale. Ignore those rather than nag forever.
    if (st.mtimeMs > now) continue;
    if (st.mtimeMs > newest.mtime) newest = { file: name, mtime: st.mtimeMs };
  }
  return newest;
}

/**
 * Capture the stamp. Called once, at startup, so `startedAt` is the boot
 * moment and every later comparison is against it.
 */
export function buildStamp(repoDir, now = Date.now()) {
  const head = headCommit(repoDir);
  const newest = newestSource(repoDir, now);
  return {
    startedAt: now,
    commit: head?.sha ? head.sha.slice(0, 7) : null,
    branch: head?.branch ?? null,
    newestSource: newest.file,
    newestSourceAt: newest.mtime || null,
  };
}

/**
 * Is a source file newer than the running process? Re-reads the directory, so
 * a file edited while the server runs is caught on the next call rather than
 * frozen at boot.
 *
 * The window is one second: a pull that lands in the same second the server
 * starts is a race nobody can act on, and reporting it as stale would cry wolf
 * on every restart-after-pull that got the order right.
 */
export function isStale(stamp, repoDir, now = Date.now()) {
  const newest = newestSource(repoDir, now);
  if (!newest.file) return { stale: false, file: null, mtime: null };
  const stale = newest.mtime > stamp.startedAt + 1000;
  return { stale, file: stale ? newest.file : null, mtime: newest.mtime };
}

/** One line for the startup banner. */
export function stampLine(stamp) {
  const where = stamp.commit
    ? `${stamp.branch ? stamp.branch + ' ' : ''}${stamp.commit}`
    : 'unknown commit';
  return `running ${where}`;
}
