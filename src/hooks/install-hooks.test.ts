import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BEGIN, END,
  HOOK_TYPES,
  type HookType,
  buildManagedBlock, upsertBlock, stripBlock,
  discoverRepos, installHooks,
} from './install-hooks.js';

// ── Pure block operations ─────────────────────────────────────────────────────

describe('buildManagedBlock', () => {
  it('fences the block with the markers and bakes both absolute paths (post-commit default)', () => {
    const block = buildManagedBlock('/tool/scripts/reindex-bg.sh', '/repo/rag.config.json');

    expect(block.startsWith(BEGIN)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
    expect(block).toContain(`'/tool/scripts/reindex-bg.sh'`);
    expect(block).toContain(`'/repo/rag.config.json'`);
    expect(block).toContain('&'); // detached into the background
    expect(block).toContain(`'post-commit'`); // trigger label baked in
  });

  it('single-quote-escapes a path containing a quote', () => {
    const block = buildManagedBlock("/a'b/reindex-bg.sh", '/c/rag.config.json');
    expect(block).toContain(`'/a'\\''b/reindex-bg.sh'`);
  });

  it('post-checkout block wraps the call in a branch-switch guard ($3 == 1)', () => {
    const block = buildManagedBlock('/s/reindex-bg.sh', '/c/rag.config.json', 'post-checkout');
    expect(block).toContain('if [ "$3" = "1" ]');
    expect(block).toContain(`'post-checkout'`);
  });

  it('post-checkout block does not contain a $3=0 path — guard handles file-restore by exclusion', () => {
    const block = buildManagedBlock('/s/reindex-bg.sh', '/c/rag.config.json', 'post-checkout');
    // Only branch switches ($3=1) should pass; no explicit $3=0 branch needed.
    expect(block).toContain('"1"');
    expect(block).not.toContain('"0"');
  });

  it('post-merge block has no branch-switch guard and bakes trigger label', () => {
    const block = buildManagedBlock('/s/reindex-bg.sh', '/c/rag.config.json', 'post-merge');
    expect(block).not.toContain('$3');
    expect(block).toContain(`'post-merge'`);
    expect(block).toContain(BEGIN);
    expect(block).toContain(END);
  });

  it('all three hook types bake their own trigger label', () => {
    for (const hookType of HOOK_TYPES) {
      const block = buildManagedBlock('/s/r.sh', '/c/rag.config.json', hookType);
      expect(block).toContain(`'${hookType}'`);
    }
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

function hookPath(repo: string, hookType: HookType = 'post-commit'): string {
  return join(repo, '.git', 'hooks', hookType);
}

describe('installHooks — topologies', () => {
  it('(A) single project: one repo → three hooks (one per hook type)', () => {
    gitInit(scratch);
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);

    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(results).toHaveLength(3); // 1 repo × 3 hook types
    expect(results.every((r) => r.action === 'created')).toBe(true);
    for (const hookType of HOOK_TYPES) {
      const path = hookPath(scratch, hookType);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(BEGIN);
      expect(statSync(path).mode & 0o100).toBeTruthy(); // owner-executable
    }
  });

  it('(B) monorepo: one repo, many segments → still three hooks (dedup by toplevel)', () => {
    gitInit(scratch);
    mkdirSync(join(scratch, 'packages/web/src'), { recursive: true });
    mkdirSync(join(scratch, 'packages/api/src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [
      { name: 'web', root: 'packages/web/src' },
      { name: 'api', root: 'packages/api/src' },
    ]);

    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(results).toHaveLength(3); // 1 repo × 3 hooks
    for (const hookType of HOOK_TYPES) {
      expect(existsSync(hookPath(scratch, hookType))).toBe(true);
    }
  });

  it('(C) separate repos under a non-repo root → three hooks per sub-repo', () => {
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

    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(results).toHaveLength(6); // 2 repos × 3 hooks
    for (const hookType of HOOK_TYPES) {
      expect(existsSync(hookPath(web, hookType))).toBe(true);
      expect(existsSync(hookPath(mobile, hookType))).toBe(true);
    }
    // The baked block points back at the shared config.
    expect(readFileSync(hookPath(web), 'utf8')).toContain(config);
    expect(existsSync(join(scratch, '.git'))).toBe(false);
  });

  it('skips segment roots that are outside any git repository', () => {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);

    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(results).toEqual([]);
  });

  it('(worktree) resolves the shared hooks dir via --git-path, not a hard-coded .git/hooks', () => {
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

    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(results).toHaveLength(3); // 1 repo × 3 hooks
    expect(results.every((r) => existsSync(r.hookPath))).toBe(true);
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

  it('re-running does not duplicate any block', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });
    const second = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(second.every((r) => r.action === 'updated')).toBe(true);
    for (const hookType of HOOK_TYPES) {
      const body = readFileSync(hookPath(scratch, hookType), 'utf8');
      expect(body.split(BEGIN)).toHaveLength(2); // exactly one block
    }
  });

  it('appends to a pre-existing foreign post-commit and preserves it; other hooks are created', () => {
    const config = singleRepo();
    writeFileSync(hookPath(scratch), '#!/bin/sh\necho "husky"\n');

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(res.find((r) => r.hookType === 'post-commit')!.action).toBe('appended');
    const body = readFileSync(hookPath(scratch), 'utf8');
    expect(body).toContain('echo "husky"');
    expect(body).toContain(BEGIN);

    // Other hooks have no foreign content — created from scratch
    expect(res.find((r) => r.hookType === 'post-checkout')!.action).toBe('created');
    expect(res.find((r) => r.hookType === 'post-merge')!.action).toBe('created');
  });

  it('uninstall removes all three scaffold files when installer created them', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    expect(res.every((r) => r.action === 'removed')).toBe(true);
    for (const hookType of HOOK_TYPES) {
      expect(existsSync(hookPath(scratch, hookType))).toBe(false);
    }
  });

  it('uninstall strips only our block from foreign hooks, leaving foreign content intact', () => {
    const config = singleRepo();
    for (const hookType of HOOK_TYPES) {
      writeFileSync(hookPath(scratch, hookType), `#!/bin/sh\necho "${hookType}-foreign"\n`);
    }
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    expect(res.every((r) => r.action === 'cleared')).toBe(true);
    for (const hookType of HOOK_TYPES) {
      const body = readFileSync(hookPath(scratch, hookType), 'utf8');
      expect(body).toContain(`echo "${hookType}-foreign"`);
      expect(body).not.toContain(BEGIN);
    }
  });

  it('dry run discovers all three targets without writing anything', () => {
    const config = singleRepo();
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, dry: true });

    expect(res.every((r) => r.action === 'created')).toBe(true);
    for (const hookType of HOOK_TYPES) {
      expect(existsSync(hookPath(scratch, hookType))).toBe(false);
    }
  });

  it('uninstall does NOT delete a foreign shebang-only hook', () => {
    const config = singleRepo();
    writeFileSync(hookPath(scratch), '#!/bin/sh\n');
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });

    const commitRes = res.find((r) => r.hookType === 'post-commit')!;
    expect(commitRes.action).toBe('cleared'); // we appended, so strip-only
    expect(existsSync(hookPath(scratch))).toBe(true); // file survives
    expect(readFileSync(hookPath(scratch), 'utf8')).not.toContain(BEGIN);
  });

  it('refuses to append to a non-sh hook; other hook types are still created', () => {
    const config = singleRepo();
    const python = '#!/usr/bin/env python3\nprint("hi")\n';
    writeFileSync(hookPath(scratch), python);

    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    expect(res.find((r) => r.hookType === 'post-commit')!.action).toBe('skipped-foreign');
    expect(readFileSync(hookPath(scratch), 'utf8')).toBe(python); // byte-for-byte intact

    // post-checkout and post-merge don't exist yet — created normally
    expect(res.find((r) => r.hookType === 'post-checkout')!.action).toBe('created');
    expect(res.find((r) => r.hookType === 'post-merge')!.action).toBe('created');
  });

  it('uninstall on a repo with no hooks reports absent for each hook type', () => {
    const config = singleRepo();
    const res = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT, uninstall: true });
    expect(res.every((r) => r.action === 'absent')).toBe(true);
    expect(res).toHaveLength(3);
  });
});

describe('installHooks — post-checkout and post-merge hook content', () => {
  function singleRepo(): string {
    gitInit(scratch);
    mkdirSync(join(scratch, 'src'), { recursive: true });
    const config = join(scratch, 'rag.config.json');
    writeConfig(config, [{ name: 'app', root: 'src' }]);
    return config;
  }

  it('post-checkout hook contains the branch-switch guard', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const body = readFileSync(hookPath(scratch, 'post-checkout'), 'utf8');
    expect(body).toContain('[ "$3" = "1" ]');
    expect(body).toContain(`'post-checkout'`);
  });

  it('post-merge hook has no branch-switch guard', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    const body = readFileSync(hookPath(scratch, 'post-merge'), 'utf8');
    expect(body).not.toContain('$3');
    expect(body).toContain(`'post-merge'`);
  });

  it('all three hooks pass their own trigger label to reindex-bg.sh', () => {
    const config = singleRepo();
    installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    for (const hookType of HOOK_TYPES) {
      const body = readFileSync(hookPath(scratch, hookType), 'utf8');
      expect(body).toContain(`'${hookType}'`);
    }
  });

  it('each hook result carries the correct hookType field', () => {
    const config = singleRepo();
    const results = installHooks({ configPath: config, reindexScript: FAKE_SCRIPT });

    for (const hookType of HOOK_TYPES) {
      const r = results.find((x) => x.hookType === hookType);
      expect(r).toBeDefined();
      expect(r!.hookPath).toContain(hookType);
    }
  });
});

describe('discoverRepos', () => {
  it('returns an empty list when no root is inside a repo', () => {
    mkdirSync(join(scratch, 'src'), { recursive: true });
    expect(discoverRepos([join(scratch, 'src')])).toEqual([]);
  });
});
