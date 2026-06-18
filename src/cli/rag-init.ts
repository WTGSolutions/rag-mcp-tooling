#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';
import { type InstallResult, installHooks } from '../hooks/install-hooks.js';
import {
  parseCliArgs as parseIndexArgs,
  run as runIndex,
} from './rag-index.js';

// ── Layout detection ──────────────────────────────────────────────────────────

export type RagSegmentSpec = { name: string; root: string; include: string[] };

export type DetectedLayout = {
  kind: 'guidetrackee' | 'minimal';
  description: string;
  segments: RagSegmentSpec[];
};

/**
 * Heuristic: when web/ + mobile/ + wiki/ + tools/ are all present we assume the
 * GuideTrackee monorepo layout and generate the canonical four-segment config
 * (matches rag.config.json at the monorepo root). Any other layout gets the
 * minimal one-segment default pointing at src/.
 */
export function detectLayout(cwd: string): DetectedLayout {
  const has = (dir: string) => existsSync(join(cwd, dir));

  if (has('web') && has('mobile') && has('wiki') && has('tools')) {
    return {
      kind: 'guidetrackee',
      description: 'monorepo (web/ + mobile/ + wiki/ + tools/ detected)',
      segments: [
        { name: 'web', root: 'web/src', include: ['**/*.{ts,tsx}'] },
        { name: 'mobile', root: 'mobile/src', include: ['**/*.{ts,tsx}'] },
        { name: 'wiki', root: 'wiki', include: ['**/*.md'] },
        { name: 'tools', root: 'tools', include: ['**/*.{ts,md}'] },
      ],
    };
  }

  return {
    kind: 'minimal',
    description: 'minimal (src/ layout)',
    segments: [{ name: 'src', root: 'src', include: ['**/*.{ts,tsx}'] }],
  };
}

export function buildRagConfigJson(layout: DetectedLayout): string {
  const cfg = {
    segments: layout.segments,
    exclude: ['**/node_modules/**', '**/*.test.{ts,tsx}', '**/dist/**'],
    embedder: { provider: 'local', model: 'Xenova/bge-small-en-v1.5' },
    chunk: { maxTokens: 512, overlapLines: 8 },
    store: { path: '.rag/index.db' },
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

// ── .mcp.json merge ───────────────────────────────────────────────────────────

const RAG_MCP_ENTRY = {
  command: 'rag-mcp',
  args: ['--config', 'rag.config.json'],
} as const;

export type McpMergeResult =
  | { action: 'created'; content: string }
  | { action: 'updated'; content: string }
  | { action: 'skipped'; reason: 'already-configured' }
  | { action: 'error'; reason: string };

/**
 * Merges `mcpServers.rag` into an existing `.mcp.json` string (or creates one).
 * Never clobbers: returns an error result when the existing file is invalid JSON,
 * and `skipped` when `rag` is already present. Preserves all other keys/servers.
 */
export function mergeMcpJson(existing: string | null): McpMergeResult {
  if (existing === null) {
    const obj = { mcpServers: { rag: RAG_MCP_ENTRY } };
    return { action: 'created', content: `${JSON.stringify(obj, null, 2)}\n` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return {
      action: 'error',
      reason:
        'existing .mcp.json is not valid JSON — fix it manually, then re-run rag-init',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      action: 'error',
      reason:
        'existing .mcp.json root must be a JSON object — fix it manually, then re-run rag-init',
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawServers = obj['mcpServers'];
  if (
    rawServers !== undefined &&
    (typeof rawServers !== 'object' ||
      rawServers === null ||
      Array.isArray(rawServers))
  ) {
    return {
      action: 'error',
      reason:
        'existing .mcp.json has a mcpServers key that is not a plain object — fix it manually, then re-run rag-init',
    };
  }
  const servers =
    rawServers !== undefined ? (rawServers as Record<string, unknown>) : {};

  if ('rag' in servers) {
    return { action: 'skipped', reason: 'already-configured' };
  }

  const merged = { ...obj, mcpServers: { ...servers, rag: RAG_MCP_ENTRY } };
  return { action: 'updated', content: `${JSON.stringify(merged, null, 2)}\n` };
}

// ── .gitignore patch ──────────────────────────────────────────────────────────

const GITIGNORE_ENTRIES = ['.rag/', '.cache/'] as const;
const GITIGNORE_BLOCK_HEADER = '# rag-mcp (managed)';

/**
 * Appends missing entries to a .gitignore string, grouped under a labelled block.
 * Idempotent: if all entries are already present (anywhere in the file), returns
 * the original string unchanged so the caller can detect "no write needed".
 */
export function patchGitignore(existing: string): string {
  // Line-level match: `/.rag/` (rooted) does NOT satisfy `.rag/` (anywhere).
  const lines = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length === 0) return existing;
  const sep =
    existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing + sep + GITIGNORE_BLOCK_HEADER}\n${missing.join('\n')}\n`;
}

// ── Args ──────────────────────────────────────────────────────────────────────

export type RagInitArgs = {
  configPath: string;
  cwd: string;
  dry: boolean;
  yes: boolean;
  noIndex: boolean;
};

export function parseInitArgs(
  argv: string[],
  cwd = process.cwd(),
): RagInitArgs {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: 'rag.config.json' },
      dry: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      'no-index': { type: 'boolean', default: false },
    },
    strict: true,
  });
  return {
    configPath: resolve(cwd, values['config'] as string),
    cwd,
    dry: values['dry'] as boolean,
    yes: values['yes'] as boolean,
    noIndex: values['no-index'] as boolean,
  };
}

// ── Injectable deps (for testability) ────────────────────────────────────────

export type RagInitDeps = {
  /** Ask the user whether to build the index now. */
  promptFn: () => Promise<boolean>;
  /** Build the index (with download allowed). */
  runIndexFn: (configPath: string) => Promise<void>;
};

async function defaultPromptFn(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      '\nBuild index now? Downloads model (~30 MB, once) and indexes project (minutes). [t/N] ',
    );
    return /^(t|tak|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function defaultRunIndexFn(configPath: string): Promise<void> {
  process.env['RAG_ALLOW_DOWNLOAD'] = '1';
  const args = parseIndexArgs(['--config', configPath, '--full']);
  if (args === null)
    throw new Error('rag-init: failed to parse index args (internal)');
  await runIndex(args);
}

export const DEFAULT_DEPS: RagInitDeps = {
  promptFn: defaultPromptFn,
  runIndexFn: defaultRunIndexFn,
};

// ── Summary row ───────────────────────────────────────────────────────────────

type ActionRow = { action: string; subject: string; note?: string };

function printSummary(title: string, rows: ActionRow[]): void {
  process.stdout.write(`\nrag-init — ${title}\n`);
  for (const r of rows) {
    const note = r.note ? `  (${r.note})` : '';
    process.stdout.write(`  ${r.action.padEnd(14)} ${r.subject}${note}\n`);
  }
  process.stdout.write('\n');
}

// ── Main run ──────────────────────────────────────────────────────────────────

export async function run(
  args: RagInitArgs,
  deps: RagInitDeps = DEFAULT_DEPS,
): Promise<void> {
  const { configPath, cwd, dry, yes, noIndex } = args;
  const rows: ActionRow[] = [];
  let mcpError: string | null = null;

  const dryTag = dry ? ' (dry-run)' : '';

  // ── 1. rag.config.json ────────────────────────────────────────────────────
  const layout = detectLayout(cwd);
  process.stdout.write(`rag-init: detected layout — ${layout.description}\n`);

  const ragConfigExists = existsSync(configPath);
  if (ragConfigExists) {
    rows.push({
      action: 'skipped',
      subject: configPath,
      note: 'already exists',
    });
  } else {
    if (!dry) writeFileSync(configPath, buildRagConfigJson(layout));
    rows.push({
      action: dry ? 'would-create' : 'created',
      subject: configPath,
      note: layout.description,
    });
  }

  // ── 2. .mcp.json ─────────────────────────────────────────────────────────
  const mcpPath = join(cwd, '.mcp.json');
  const mcpExisting = existsSync(mcpPath)
    ? readFileSync(mcpPath, 'utf8')
    : null;
  const mcpResult = mergeMcpJson(mcpExisting);

  if (mcpResult.action === 'error') {
    mcpError = mcpResult.reason;
    rows.push({ action: 'error', subject: mcpPath, note: mcpResult.reason });
  } else if (mcpResult.action === 'skipped') {
    rows.push({
      action: 'skipped',
      subject: mcpPath,
      note: 'mcpServers.rag already present',
    });
  } else {
    if (!dry) writeFileSync(mcpPath, mcpResult.content);
    const verb =
      mcpResult.action === 'created'
        ? dry
          ? 'would-create'
          : 'created'
        : dry
          ? 'would-update'
          : 'updated';
    rows.push({ action: verb, subject: mcpPath, note: 'mcpServers.rag added' });
  }

  // ── 3. .gitignore ─────────────────────────────────────────────────────────
  const gitignorePath = join(cwd, '.gitignore');
  // Snapshot existence BEFORE any write so the summary verb is correct.
  const gitignoreExisted = existsSync(gitignorePath);
  const gitignoreExisting = gitignoreExisted
    ? readFileSync(gitignorePath, 'utf8')
    : '';
  const gitignorePatched = patchGitignore(gitignoreExisting);

  if (gitignorePatched === gitignoreExisting && gitignoreExisted) {
    rows.push({
      action: 'skipped',
      subject: gitignorePath,
      note: '.rag/ and .cache/ already present',
    });
  } else {
    if (!dry) writeFileSync(gitignorePath, gitignorePatched);
    const verb = dry
      ? 'would-update'
      : gitignoreExisted
        ? 'updated'
        : 'created';
    rows.push({
      action: verb,
      subject: gitignorePath,
      note: 'added: .rag/, .cache/',
    });
  }

  // ── 4. Git hooks ──────────────────────────────────────────────────────────
  // installHooks needs the config file to exist; in dry mode we skip it and
  // simulate instead (config hasn't been written yet).
  if (dry) {
    rows.push({
      action: 'would-install',
      subject: 'git hooks',
      note: 'post-commit, post-checkout, post-merge in repos backing config segments',
    });
  } else {
    const hookResults = tryInstallHooks(configPath);
    appendHookRows(rows, hookResults);
  }

  // ── Summary (early, before potentially-long index step) ───────────────────
  printSummary(`setup${dryTag}`, rows);

  if (mcpError) {
    process.stderr.write(`rag-init error: .mcp.json — ${mcpError}\n`);
    process.stderr.write(
      `Other steps completed successfully. Fix .mcp.json and re-run rag-init to add the server entry.\n`,
    );
  }

  if (dry) return;

  // ── 5. Index prompt ───────────────────────────────────────────────────────
  if (noIndex) {
    printIndexInstruction(configPath);
    return;
  }

  let buildIndex = false;
  if (yes) {
    buildIndex = true;
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    buildIndex = await deps.promptFn();
  } else {
    // Non-interactive environment: skip silently and instruct.
    printIndexInstruction(configPath);
    return;
  }

  if (buildIndex) {
    process.stdout.write('rag-init: building index…\n');
    await deps.runIndexFn(configPath);
    process.stdout.write(
      'rag-init: index ready — start Claude Code to use the MCP server.\n',
    );
  } else {
    printIndexInstruction(configPath);
  }
}

function tryInstallHooks(configPath: string): InstallResult[] {
  try {
    return installHooks({ configPath });
  } catch (e) {
    process.stderr.write(
      `rag-init: warning — hook install failed: ${(e as Error).message}\n`,
    );
    return [];
  }
}

function appendHookRows(rows: ActionRow[], results: InstallResult[]): void {
  if (results.length === 0) {
    rows.push({
      action: 'skipped',
      subject: 'git hooks',
      note: 'no git repo found for any segment',
    });
    return;
  }
  for (const r of results) {
    rows.push({ action: r.action, subject: r.hookPath, note: r.hookType });
  }
}

function printIndexInstruction(configPath: string): void {
  process.stdout.write(
    `rag-init: index not built. When ready, run:\n` +
      `  RAG_ALLOW_DOWNLOAD=1 rag-index --config ${configPath} --full\n` +
      `  (or: npx rag-index --config ${configPath} --full)\n`,
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: RagInitArgs;
  try {
    args = parseInitArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      `rag-init: argument error — ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  try {
    await run(args);
  } catch (e) {
    process.stderr.write(`rag-init: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (process.argv[1]) {
  // Resolve symlinks before comparing: npm's .bin/ entries are symlinks so the
  // unresolved argv[1] path would never match import.meta.url (the real path).
  let calledUrl: string;
  try {
    calledUrl = pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    calledUrl = pathToFileURL(process.argv[1]).href;
  }
  if (import.meta.url === calledUrl) void main();
}
