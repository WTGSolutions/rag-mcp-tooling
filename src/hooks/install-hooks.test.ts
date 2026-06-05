import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BEGIN, END,
  buildManagedBlock, upsertBlock, stripBlock,
  discoverRepos, installHooks,
} from './install-hooks.js';

// ── Pure block operations ─────────────────────────────────────────────────────

describe('buildManagedBlock', () => {
  it('fences the block with the markers and bakes both absolute paths', () => {
    // Arrange + Act
    const block = buildManagedBlock('/tool/scripts/reindex-bg.sh', '/repo/rag.config.json');

    // Assert
    expect(block.startsWith(BEGIN)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
    expect(block).toContain(`'/tool/scripts/reindex-bg.sh'`);
    expect(block).toContain(`'/repo/rag.config.json'`);
    expect(block).toContain('&'); // detached into the background
  });

  it('single-quote-escapes a path containing a quote', () => {
    const block = buildManagedBlock("/a'b/reindex-bg.sh", '/c/rag.config.json');
    expect(block).toContain(`'/a'\\''b/reindex-bg.sh'`);
  });
});

describe('upsertBlock', () => {
  const block = buildManagedBlock('/s/reindex-bg.sh', '/c/rag.config.json');

  it('creates a new hook with a shebang when none exists', () => {
    const out = upsertBlock(null, block);
    expect(out.startsWith('#!/bin/sh')).toBe(true);
    expect(out).toContain(BEGIN);
  });

  it('is idempotent: replacing keeps exactly one managed block', () => {
    const once = upsertBlock(null, block);
    const twice = upsertBlock(once, block);
    expect(twice.split(BEGIN)).toHaveLength(2); // one marker → split into 2 parts
    expect(twice).toBe(once);
  });

  it('appends to a foreign hook without disturbing it', () => {
    const foreign = '#!/bin/sh\necho "lint-staged"\n';
    const out = upsertBlock(foreign, block);
    expect(out).toContain('echo "lint-staged"');
    expect(out).toContain(BEGIN);
    expect(out.indexOf('echo')).toBeLessThan(out.indexOf(BEGIN)); // ours appended after
  });
});

describe('stripBlock', () => {
  const block = buildManagedBlock('/s/reindex-bg.sh', '/c/rag.config.json');

  it('removes the managed block but keeps the foreign hook', () => {
    const foreign = '#!/bin/sh\necho "keep me"\n';
    const stripped = stripBlock(upsertBlock(foreign, block));
    expect(stripped).toContain('echo "keep me"');
    expect(stripped).not.toContain(BEGIN);
  });

  it('is a no-op when there is no managed block', () => {
    const foreign = '#!/bin/sh\necho hi\n';
    expect(stripBlock(foreign)).toBe(foreign);
  });
});

// ── Integration against real temp git repos ───────────────────────────────────

let scratch: string;
const FAKE_SCRIPT = '/fake/scripts/reindex-bg.sh';

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rag-hooks-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function writeConfig(path: string, segments: { name: string; root: string }[]): void {
  const config = {
    segments: segments.map((s) => ({ ...s, include: ['**/*.ts'] })),
    store: { path: '.rag/index.db' },
  };
  writeFileSync(path, JSON.stringify(config));
}

function hookPath(repo: string): string {
  return join(repo, '.git', 'hooks', 'post-commit');
}

describe('installHooks — topologies', () => {
  it('(A) single project: one repo, config at its root → one hook', () => {
    // Arrange
    gitInit(scratch);
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);

    // Act
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe('created');
    const hook = hookPath(scratch);
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(hook, 'utf8')).toContain(BEGIN);
    expect(statSync(hook).mode & 0o100).toBeTruthy(); // owner-executable
  });

  it('(B) monorepo: one repo, many segments → still one hook (dedup by toplevel)', () => {
    // Arrange
    gitInit(scratch);
    mkdirSync(join(scratch, 'packages/web/src'), { recursive: true });
    mkdirSync(join(scratch, 'packages/api/src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [
      { name: 'web', root: 'packages/web/src' },
      { name: 'api', root: 'packages/api/src' },
    ]);

    // Act
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert
    expect(results).toHaveLength(1);
    expect(existsSync(hookPath(scratch))).toBe(true);
  });

  it('(C) separate repos under a non-repo root → one hook per sub-repo', () => {
    // Arrange — scratch is NOT a git repo; web/ and mobile/ are
    const web = join(scratch, 'web');
    const mobile = join(scratch, 'mobile');
    gitInit(web);
    gitInit(mobile);
    mkdirSync(join(web, 'src'), { recursive: true });
    mkdirSync(join(mobile, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [
      { name: 'web', root: 'web/src' },
      { name: 'mobile', root: 'mobile/src' },
    ]);

    // Act
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert — two distinct repos, two hooks; the non-repo root gets none
    expect(results).toHaveLength(2);
    expect(existsSync(hookPath(web))).toBe(true);
    expect(existsSync(hookPath(mobile))).toBe(true);
    expect(existsSync(join(scratch, '.git'))).toBe(false);
    // The baked block points back at the shared config.
    expect(readFileSync(hookPath(web), 'utf8')).toContain(config);
  });

  it('skips segment roots that are outside any git repository', () => {
    // Arrange — config and segment exist, but nothing is a git repo
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);

    // Act
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert
    expect(results).toEqual([]);
  });

  it('(worktree) resolves the shared hooks dir via --git-path, not a hard-coded .git/hooks', () => {
    // Arrange — a repo with a commit, then a linked worktree whose hooks live in
    // the COMMON git dir; a hard-coded `<toplevel>/.git/hooks` would miss it.
    const mainRepo = join(scratch, 'main');
    gitInit(mainRepo);
    const g = (...a: string[]) => execFileSync('git', ['-C', mainRepo, ...a], { stdio: 'ignore' });
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('commit', '--allow-empty', '-m', 'init');
    const wt = join(scratch, 'wt');
    g('worktree', 'add', '-q', wt);
    mkdirSync(join(wt, 'src'), { recursive: true });
    const config = join(wt, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);

    // Act
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert — one hook, written into the resolved (shared) hooks dir
    expect(results).toHaveLength(1);
    expect(existsSync(results[0]!.hookPath)).toBe(true);
    expect(readFileSync(results[0]!.hookPath, 'utf8')).toContain(BEGIN);
  });
});

describe('installHooks — idempotency, coexistence, uninstall', () => {
  function singleRepo(): string {
    gitInit(scratch);
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);
    return config;
  }

  it('re-running does not duplicate the block', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });
    const second = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(second[0]!.action).toBe('updated');
    const body = readFileSync(hookPath(scratch), 'utf8');
    expect(body.split(BEGIN)).toHaveLength(2); // exactly one block
  });

  it('appends to a pre-existing foreign hook and preserves it', () => {
    const config = singleRepo();
    writeFileSync(hookPath(scratch), '#!/bin/sh\necho "husky"\n');

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(res[0]!.action).toBe('appended');
    const body = readFileSync(hookPath(scratch), 'utf8');
    expect(body).toContain('echo "husky"');
    expect(body).toContain(BEGIN);
  });

  it('uninstall removes our own scaffold file entirely', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    expect(res[0]!.action).toBe('removed');
    expect(existsSync(hookPath(scratch))).toBe(false);
  });

  it('uninstall strips only our block from a foreign hook', () => {
    const config = singleRepo();
    writeFileSync(hookPath(scratch), '#!/bin/sh\necho "husky"\n');
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    expect(res[0]!.action).toBe('cleared');
    const body = readFileSync(hookPath(scratch), 'utf8');
    expect(body).toContain('echo "husky"');
    expect(body).not.toContain(BEGIN);
  });

  it('dry run discovers targets without writing anything', () => {
    const config = singleRepo();
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, dry: true });

    expect(res[0]!.action).toBe('created');
    expect(existsSync(hookPath(scratch))).toBe(false);
  });

  it('uninstall does NOT delete a foreign shebang-only hook', () => {
    // Arrange — a deliberate bare-shebang hook (not ours), then install appends.
    const config = singleRepo();
    writeFileSync(hookPath(scratch), '#!/bin/sh\n');
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Act
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    // Assert — file survives (we never created it), only our block is gone
    expect(res[0]!.action).toBe('cleared');
    expect(existsSync(hookPath(scratch))).toBe(true);
    expect(readFileSync(hookPath(scratch), 'utf8')).not.toContain(BEGIN);
  });

  it('refuses to append to a non-sh hook, leaving it untouched', () => {
    // Arrange — a Python post-commit; appending shell would corrupt it
    const config = singleRepo();
    const python = '#!/usr/bin/env python3\nprint("hi")\n';
    writeFileSync(hookPath(scratch), python);

    // Act
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    // Assert
    expect(res[0]!.action).toBe('skipped-foreign');
    expect(readFileSync(hookPath(scratch), 'utf8')).toBe(python); // byte-for-byte intact
  });

  it('uninstall on a repo with no hook reports absent', () => {
    const config = singleRepo();
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });
    expect(res[0]!.action).toBe('absent');
  });
});

describe('discoverRepos', () => {
  it('returns an empty list when no root is inside a repo', () => {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    expect(discoverRepos([join(scratch, 'src')])).toEqual([]);
  });
});
