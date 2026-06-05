#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';
import { loadConfig, ConfigError } from '../config.js';

// Markers fencing the managed region of a post-commit hook. They are the basis
// of idempotency and of coexisting with a foreign hook (Husky, lint-staged): we
// only ever touch the text between them, never the rest of the file.
export const BEGIN = '# >>> rag-mcp auto-reindex (managed) >>>';
export const END = '# <<< rag-mcp auto-reindex (managed) <<<';

// Stamped into a hook file that the installer created from scratch, so uninstall
// can delete the whole file only when *we* own it — never a foreign hook that
// merely happened to be a bare shebang when we appended to it.
export const CREATED_MARK = '# created by rag-mcp install-hooks';

/**
 * Absolute path to the shared reindex script, resolved relative to this compiled
 * file (dist/hooks/install-hooks.js → <tool>/scripts/reindex-bg.sh). Baked into
 * the hook at install time so the stub never assumes where the tool lives.
 */
export function defaultReindexScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../scripts/reindex-bg.sh');
}

/** POSIX single-quote a path so spaces/specials in it survive in the hook. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * The managed post-commit block. Absolute paths to the shared runner and the
 * config are baked in at install time, so the stub stays trivial and works in
 * every topology (single repo, monorepo, separate repos under a non-repo root).
 */
export function buildManagedBlock(reindexScript: string, configPath: string): string {
  return [
    BEGIN,
    '# Auto-reindex the RAG semantic index after each commit (background, non-fatal).',
    '# Managed by `rag-index install-hooks` — edit reindex-bg.sh, not this block.',
    `( sh ${shQuote(reindexScript)} ${shQuote(configPath)} >/dev/null 2>&1 & )`,
    END,
  ].join('\n');
}

/** End marker searched only *after* the begin marker, so a stray/duplicate END
 * above BEGIN can't make the slice region invert and corrupt the file. */
function blockBounds(s: string): { start: number; end: number } {
  const start = s.indexOf(BEGIN);
  const end = start === -1 ? -1 : s.indexOf(END, start);
  return { start, end };
}

/** Insert or replace the managed block; create a fresh hook when none exists. */
export function upsertBlock(existing: string | null, block: string): string {
  if (existing === null) return `#!/bin/sh\n${CREATED_MARK}\n\n${block}\n`;
  const { start, end } = blockBounds(existing);
  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  // Foreign hook present, no managed block yet → append ours, keep theirs.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block + '\n';
}

/** Remove the managed block, leaving any surrounding (foreign) hook intact. */
export function stripBlock(existing: string): string {
  const { start, end } = blockBounds(existing);
  if (start === -1 || end === -1) return existing;
  const out = existing.slice(0, start) + existing.slice(end + END.length);
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
}

/**
 * True if appending our `( sh … )` line to this hook is safe. Git runs the hook
 * through its shebang; a non-sh interpreter (python, node) would choke on shell
 * syntax, so we refuse to touch those. No shebang → git uses /bin/sh → safe.
 */
export function isPosixShHook(existing: string): boolean {
  const firstLine = existing.split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith('#!')) return true;
  return /\b(sh|bash|dash|ksh|zsh)\b/.test(firstLine);
}

/** True when nothing but our own scaffold (shebang + created-mark + blanks) is left. */
function isOnlyScaffold(stripped: string): boolean {
  return stripped.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || t.startsWith('#!') || t === CREATED_MARK;
  });
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export type RepoTarget = { toplevel: string; hooksDir: string };

/**
 * Map each segment root to the git repository that contains it, de-duplicated by
 * toplevel. This is what makes the installer topology-agnostic: a monorepo's
 * segments all resolve to one toplevel (→ 1 hook); separate repos resolve to
 * distinct toplevels (→ N hooks). A root outside any repo (git fails) is skipped.
 */
export function discoverRepos(segmentRoots: string[]): RepoTarget[] {
  const byTop = new Map<string, RepoTarget>();
  for (const root of segmentRoots) {
    // Run git from the segment root itself. A missing/typo'd root makes git fail
    // (→ null → skip) rather than us guessing a parent and hitting the wrong repo.
    const toplevel = git(root, ['rev-parse', '--show-toplevel']);
    if (!toplevel || byTop.has(toplevel)) continue;
    // --git-path keeps us correct under worktrees / a relocated hooks dir.
    const hooksRel = git(toplevel, ['rev-parse', '--git-path', 'hooks']);
    if (!hooksRel) continue;
    byTop.set(toplevel, { toplevel, hooksDir: resolve(toplevel, hooksRel) });
  }
  return [...byTop.values()];
}

export type HookAction = 'created' | 'updated' | 'appended' | 'removed' | 'cleared' | 'absent' | 'skipped-foreign';
export type InstallResult = { toplevel: string; hookPath: string; action: HookAction };

export type InstallOptions = {
  configPath: string;
  /** Override the baked reindex-script path (used by tests). */
  reindexScript?: string;
  uninstall?: boolean;
  /** Discover + report targets without touching the filesystem. */
  dry?: boolean;
};

/**
 * Install (or uninstall) the managed post-commit hook in every git repo backing
 * the config's segments. Idempotent: re-running replaces the block in place.
 */
export function installHooks(opts: InstallOptions): InstallResult[] {
  const configPath = resolve(opts.configPath);
  const config = loadConfig(configPath); // validates the config; throws on a bad/missing file
  const configDir = dirname(configPath);
  const roots = config.segments.map((s) => resolve(configDir, s.root));
  const block = buildManagedBlock(opts.reindexScript ?? defaultReindexScript(), configPath);

  const results: InstallResult[] = [];
  for (const { toplevel, hooksDir } of discoverRepos(roots)) {
    const hookPath = join(hooksDir, 'post-commit');
    const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;

    if (opts.uninstall) {
      if (existing === null || !existing.includes(BEGIN) || !existing.includes(END)) {
        results.push({ toplevel, hookPath, action: 'absent' });
        continue;
      }
      const stripped = stripBlock(existing);
      // Delete the file only when we created it and nothing but our scaffold is
      // left — never a foreign hook (even one that was just a bare shebang).
      if (existing.includes(CREATED_MARK) && isOnlyScaffold(stripped)) {
        if (!opts.dry) rmSync(hookPath, { force: true });
        results.push({ toplevel, hookPath, action: 'removed' });
      } else {
        if (!opts.dry) writeFileSync(hookPath, stripped);
        results.push({ toplevel, hookPath, action: 'cleared' });
      }
      continue;
    }

    // Refuse to append to a hook written in a non-sh language — appending shell
    // syntax would corrupt it. Updating our own existing block is always fine.
    if (existing !== null && !existing.includes(BEGIN) && !isPosixShHook(existing)) {
      results.push({ toplevel, hookPath, action: 'skipped-foreign' });
      continue;
    }

    const action: HookAction =
      existing === null ? 'created' : existing.includes(BEGIN) ? 'updated' : 'appended';
    if (!opts.dry) {
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(hookPath, upsertBlock(existing, block));
      chmodSync(hookPath, 0o755);
    }
    results.push({ toplevel, hookPath, action });
  }
  return results;
}

/**
 * Whether `.rag/` (where the hook writes log + lock) is gitignored inside a repo.
 * Returns null when `.rag/` lives outside the repo (the separate-repos topology,
 * where it sits at the non-repo root and can never be committed).
 */
function ragDirIgnored(toplevel: string, ragDir: string): boolean | null {
  const rel = relative(toplevel, ragDir);
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // outside this repo
  try {
    execFileSync('git', ['-C', toplevel, 'check-ignore', '-q', rel], { stdio: 'ignore' });
    return true; // exit 0 → ignored
  } catch {
    return false; // exit 1 → not ignored
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export type CliArgs = { config: string; uninstall: boolean; dry: boolean };

export function parseArgs(argv: string[]): CliArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: 'rag.config.json' },
      uninstall: { type: 'boolean', default: false },
      dry: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return { config: values.config as string, uninstall: values.uninstall as boolean, dry: values.dry as boolean };
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`install-hooks: ${(e as Error).message}\n`);
    process.exit(1);
  }

  let results: InstallResult[];
  try {
    results = installHooks({ configPath: args.config, uninstall: args.uninstall, dry: args.dry });
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : `unexpected error: ${(e as Error).message}`;
    process.stderr.write(`install-hooks: ${msg}\n`);
    process.exit(1);
  }

  const verb = args.uninstall ? 'uninstall' : 'install';
  const tag = args.dry ? ' (dry-run)' : '';
  if (results.length === 0) {
    process.stderr.write(`install-hooks: no git repository found for any segment in ${args.config}\n`);
    return;
  }

  process.stdout.write(`rag-mcp post-commit hook — ${verb}${tag}\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.action.padEnd(14)} ${r.hookPath}\n`);
  }

  if (results.some((r) => r.action === 'skipped-foreign')) {
    process.stderr.write(
      `\nwarning: skipped repo(s) with a non-sh post-commit hook — appending shell ` +
      `would corrupt them. Add the block manually or convert the hook to sh.\n`,
    );
  }

  // Warn once if .rag/ (log + lock home) isn't gitignored inside a target repo.
  if (!args.uninstall && !args.dry) {
    const ragDir = resolve(dirname(resolve(args.config)), '.rag');
    const exposed = results
      .map((r) => r.toplevel)
      .filter((top, i, a) => a.indexOf(top) === i)
      .filter((top) => ragDirIgnored(top, ragDir) === false);
    if (exposed.length > 0) {
      process.stderr.write(
        `\nwarning: ${ragDir} is not gitignored — the hook will dirty 'git status' ` +
        `on every commit. Add '.rag/' to .gitignore.\n`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
