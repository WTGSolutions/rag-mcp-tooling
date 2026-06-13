import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectLayout,
  buildRagConfigJson,
  mergeMcpJson,
  patchGitignore,
  parseInitArgs,
  run,
  type RagInitDeps,
} from './rag-init.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rag-init-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Deps that never prompt and never run index — safe for fs-focused tests. */
const noDeps: RagInitDeps = {
  promptFn: async () => false,
  runIndexFn: async () => {},
};

/** Deps that simulate the user answering "yes" to build index. */
function yesDeps(onIndex: (p: string) => void): RagInitDeps {
  return {
    promptFn: async () => true,
    runIndexFn: async (configPath) => onIndex(configPath),
  };
}

// ── detectLayout ──────────────────────────────────────────────────────────────

describe('detectLayout', () => {
  it('returns guidetrackee when web/ mobile/ wiki/ tools/ all present', () => {
    for (const d of ['web', 'mobile', 'wiki', 'tools']) mkdirSync(join(tmp, d));
    const layout = detectLayout(tmp);
    expect(layout.kind).toBe('guidetrackee');
    expect(layout.segments.map((s) => s.name)).toEqual(['web', 'mobile', 'wiki', 'tools']);
  });

  it('returns minimal when only some dirs present', () => {
    mkdirSync(join(tmp, 'web'));
    const layout = detectLayout(tmp);
    expect(layout.kind).toBe('minimal');
    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]!.name).toBe('src');
  });

  it('returns minimal for an empty directory', () => {
    expect(detectLayout(tmp).kind).toBe('minimal');
  });
});

describe('buildRagConfigJson', () => {
  it('produces valid JSON with required keys', () => {
    const layout = detectLayout(tmp); // minimal
    const json = buildRagConfigJson(layout);
    const obj = JSON.parse(json);
    expect(Array.isArray(obj.segments)).toBe(true);
    expect(obj.embedder.model).toBe('Xenova/bge-small-en-v1.5');
    expect(obj.store.path).toBe('.rag/index.db');
  });
});

// ── mergeMcpJson ──────────────────────────────────────────────────────────────

describe('mergeMcpJson', () => {
  it('creates minimal .mcp.json when file absent', () => {
    const r = mergeMcpJson(null);
    expect(r.action).toBe('created');
    if (r.action !== 'created') return;
    const obj = JSON.parse(r.content);
    expect(obj.mcpServers.rag.command).toBe('rag-mcp');
    expect(obj.mcpServers.rag.args).toEqual(['--config', 'rag.config.json']);
  });

  it('adds rag entry while keeping existing servers', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }, null, 2);
    const r = mergeMcpJson(existing);
    expect(r.action).toBe('updated');
    if (r.action !== 'updated') return;
    const obj = JSON.parse(r.content);
    expect(obj.mcpServers.other.command).toBe('other-mcp');
    expect(obj.mcpServers.rag.command).toBe('rag-mcp');
  });

  it('is idempotent — skips when rag already configured', () => {
    const existing = JSON.stringify({ mcpServers: { rag: { command: 'rag-mcp' } } });
    const r = mergeMcpJson(existing);
    expect(r.action).toBe('skipped');
  });

  it('returns error for invalid JSON without clobbering', () => {
    const r = mergeMcpJson('this is not json {{{');
    expect(r.action).toBe('error');
  });

  it('returns error when root is a JSON array', () => {
    const r = mergeMcpJson('[]');
    expect(r.action).toBe('error');
  });

  it('returns error when mcpServers is an array (would silently destroy it)', () => {
    const r = mergeMcpJson(JSON.stringify({ mcpServers: ['legacy'] }));
    expect(r.action).toBe('error');
    if (r.action !== 'error') return;
    expect(r.reason).toContain('mcpServers');
  });

  it('returns error when mcpServers is a non-object primitive', () => {
    const r = mergeMcpJson(JSON.stringify({ mcpServers: 'string-value' }));
    expect(r.action).toBe('error');
  });

  it('preserves top-level keys outside mcpServers', () => {
    const existing = JSON.stringify({ version: 1, mcpServers: {} }, null, 2);
    const r = mergeMcpJson(existing);
    expect(r.action).toBe('updated');
    if (r.action !== 'updated') return;
    expect(JSON.parse(r.content).version).toBe(1);
  });
});

// ── patchGitignore ────────────────────────────────────────────────────────────

describe('patchGitignore', () => {
  it('appends missing entries to an existing .gitignore', () => {
    const patched = patchGitignore('node_modules/\n');
    expect(patched).toContain('.rag/');
    expect(patched).toContain('.cache/');
    expect(patched).toContain('node_modules/');
  });

  it('is idempotent — no change when entries already present', () => {
    const base = 'node_modules/\n.rag/\n.cache/\n';
    expect(patchGitignore(base)).toBe(base);
  });

  it('only appends the truly missing entry', () => {
    const base = '.rag/\n';
    const patched = patchGitignore(base);
    expect(patched).toContain('.cache/');
    // .rag/ must not be duplicated
    expect(patched.split('.rag/').length - 1).toBe(1);
  });

  it('handles empty string', () => {
    const patched = patchGitignore('');
    expect(patched).toContain('.rag/');
    expect(patched).toContain('.cache/');
    // No leading blank line when file was empty
    expect(patched.startsWith('\n')).toBe(false);
  });

  it('does not treat a rooted /.cache/ as satisfying .cache/', () => {
    // /.cache/ only ignores at repo root; .cache/ ignores anywhere — they are distinct.
    const base = '/.rag/\n/.cache/\n';
    const patched = patchGitignore(base);
    expect(patched).toContain('.rag/');   // the non-rooted form must still be added
    expect(patched).toContain('.cache/'); // same
  });
});

// ── parseInitArgs ─────────────────────────────────────────────────────────────

describe('parseInitArgs', () => {
  it('returns defaults', () => {
    const args = parseInitArgs([], tmp);
    expect(args.dry).toBe(false);
    expect(args.yes).toBe(false);
    expect(args.noIndex).toBe(false);
    expect(args.configPath).toContain('rag.config.json');
    expect(args.cwd).toBe(tmp);
  });

  it('parses --dry --yes --no-index', () => {
    const args = parseInitArgs(['--dry', '--yes', '--no-index'], tmp);
    expect(args.dry).toBe(true);
    expect(args.yes).toBe(true);
    expect(args.noIndex).toBe(true);
  });

  it('resolves --config relative to cwd', () => {
    const args = parseInitArgs(['-c', 'subdir/my.config.json'], tmp);
    expect(args.configPath).toBe(join(tmp, 'subdir/my.config.json'));
  });
});

// ── run() — rag.config.json ───────────────────────────────────────────────────

describe('run — rag.config.json', () => {
  it('creates rag.config.json when absent', async () => {
    const configPath = join(tmp, 'rag.config.json');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    expect(existsSync(configPath)).toBe(true);
    const obj = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(Array.isArray(obj.segments)).toBe(true);
  });

  it('does not overwrite an existing rag.config.json', async () => {
    const configPath = join(tmp, 'rag.config.json');
    const original = '{"segments":[{"name":"custom","root":"x","include":["**/*"]}],"exclude":[],"embedder":{"provider":"local","model":"Xenova/bge-small-en-v1.5"},"chunk":{"maxTokens":512,"overlapLines":8},"store":{"path":".rag/index.db"}}';
    writeFileSync(configPath, original);
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });
});

// ── run() — .mcp.json ─────────────────────────────────────────────────────────

describe('run — .mcp.json', () => {
  it('creates .mcp.json with mcpServers.rag when absent', async () => {
    const configPath = join(tmp, 'rag.config.json');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const mcp = JSON.parse(readFileSync(join(tmp, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.rag.command).toBe('rag-mcp');
  });

  it('merges rag into existing .mcp.json without touching other servers', async () => {
    const configPath = join(tmp, 'rag.config.json');
    writeFileSync(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const mcp = JSON.parse(readFileSync(join(tmp, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other.command).toBe('x');
    expect(mcp.mcpServers.rag.command).toBe('rag-mcp');
  });

  it('does not clobber invalid .mcp.json', async () => {
    const configPath = join(tmp, 'rag.config.json');
    const bad = 'not json {{{';
    writeFileSync(join(tmp, '.mcp.json'), bad);
    // Should not throw; just reports error in summary
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    expect(readFileSync(join(tmp, '.mcp.json'), 'utf8')).toBe(bad);
  });

  it('is idempotent — skips when rag already present', async () => {
    const configPath = join(tmp, 'rag.config.json');
    const existing = JSON.stringify({ mcpServers: { rag: { command: 'rag-mcp', args: [] } } });
    writeFileSync(join(tmp, '.mcp.json'), existing);
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    expect(readFileSync(join(tmp, '.mcp.json'), 'utf8')).toBe(existing);
  });
});

// ── run() — .gitignore ────────────────────────────────────────────────────────

describe('run — .gitignore', () => {
  it('creates .gitignore with rag entries when absent', async () => {
    const configPath = join(tmp, 'rag.config.json');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(gi).toContain('.rag/');
    expect(gi).toContain('.cache/');
  });

  it('appends to existing .gitignore without duplicating', async () => {
    const configPath = join(tmp, 'rag.config.json');
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n.rag/\n');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(gi.split('.rag/').length - 1).toBe(1); // no duplicate
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('.cache/');
  });

  it('is idempotent on re-run — no duplicate entries', async () => {
    const configPath = join(tmp, 'rag.config.json');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const after1 = readFileSync(join(tmp, '.gitignore'), 'utf8');
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, noDeps);
    const after2 = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(after1).toBe(after2);
  });
});

// ── run() — --dry mode ────────────────────────────────────────────────────────

describe('run — --dry mode', () => {
  it('writes nothing to the filesystem in dry mode', async () => {
    const configPath = join(tmp, 'rag.config.json');
    await run({ configPath, cwd: tmp, dry: true, yes: false, noIndex: false }, noDeps);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(tmp, '.mcp.json'))).toBe(false);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });
});

// ── run() — index prompt / --yes / --no-index ─────────────────────────────────

describe('run — index building', () => {
  it('--no-index skips index without prompting', async () => {
    const configPath = join(tmp, 'rag.config.json');
    let prompted = false;
    let indexed = false;
    const deps: RagInitDeps = {
      promptFn: async () => { prompted = true; return true; },
      runIndexFn: async () => { indexed = true; },
    };
    await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: true }, deps);
    expect(prompted).toBe(false);
    expect(indexed).toBe(false);
  });

  it('--yes runs index without prompting', async () => {
    const configPath = join(tmp, 'rag.config.json');
    let prompted = false;
    let indexedWith: string | null = null;
    const deps: RagInitDeps = {
      promptFn: async () => { prompted = true; return false; },
      runIndexFn: async (p) => { indexedWith = p; },
    };
    // Force isTTY to true so --yes path is reached (not the non-TTY skip path)
    const origTTY = process.stdout.isTTY;
    (process.stdout as { isTTY: boolean }).isTTY = true;
    (process.stdin as { isTTY: boolean }).isTTY = true;
    try {
      await run({ configPath, cwd: tmp, dry: false, yes: true, noIndex: false }, deps);
    } finally {
      (process.stdout as { isTTY: boolean }).isTTY = origTTY;
      (process.stdin as { isTTY: boolean }).isTTY = origTTY;
    }
    expect(prompted).toBe(false);
    expect(indexedWith).toBe(configPath);
  });

  it('does not hang in non-TTY — skips index and prints instruction', async () => {
    const configPath = join(tmp, 'rag.config.json');
    let indexed = false;
    const deps: RagInitDeps = {
      promptFn: async () => true,
      runIndexFn: async () => { indexed = true; },
    };
    // Simulate non-TTY (CI)
    const origOut = process.stdout.isTTY;
    const origIn  = process.stdin.isTTY;
    (process.stdout as { isTTY: boolean }).isTTY = false;
    (process.stdin  as { isTTY: boolean }).isTTY = false;
    try {
      await run({ configPath, cwd: tmp, dry: false, yes: false, noIndex: false }, deps);
    } finally {
      (process.stdout as { isTTY: boolean }).isTTY = origOut;
      (process.stdin  as { isTTY: boolean }).isTTY = origIn;
    }
    expect(indexed).toBe(false);
  });
});
