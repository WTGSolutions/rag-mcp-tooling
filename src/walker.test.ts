import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { walkSegments, detectLanguage, type WalkedFile } from './walker.js';
import type { RagConfig } from './config.js';

const MINI_REPO = join(import.meta.dirname, '__fixtures__', 'mini-repo');

async function collect(gen: AsyncGenerator<WalkedFile>): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  for await (const f of gen) files.push(f);
  return files;
}

function makeConfig(root: string, overrides: Partial<RagConfig> = {}): RagConfig {
  return {
    segments: [{ name: 'src', root, include: ['**/*.{ts,tsx,js,md}'] }],
    exclude: [],
    embedder: { provider: 'local', model: 'test' },
    chunk: { maxTokens: 512, overlapLines: 8 },
    store: { path: '.rag/index.db' },
    ...overrides,
  };
}

describe('detectLanguage', () => {
  it('identifies TypeScript extensions', () => {
    expect(detectLanguage('foo/bar.ts')).toBe('typescript');
    expect(detectLanguage('foo/bar.tsx')).toBe('typescript');
  });

  it('identifies JavaScript extensions', () => {
    expect(detectLanguage('foo/bar.js')).toBe('javascript');
    expect(detectLanguage('foo/bar.jsx')).toBe('javascript');
    expect(detectLanguage('foo/bar.mjs')).toBe('javascript');
    expect(detectLanguage('foo/bar.cjs')).toBe('javascript');
  });

  it('identifies Markdown extensions', () => {
    expect(detectLanguage('foo/bar.md')).toBe('markdown');
    expect(detectLanguage('foo/bar.mdx')).toBe('markdown');
  });

  it('returns unknown for unrecognised extensions', () => {
    expect(detectLanguage('foo/bar.json')).toBe('unknown');
    expect(detectLanguage('foo/bar.css')).toBe('unknown');
    expect(detectLanguage('foo/bar')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('foo/bar.TS')).toBe('typescript');
    expect(detectLanguage('foo/bar.MD')).toBe('markdown');
  });
});

describe('walkSegments', () => {
  describe('file metadata', () => {
    it('returns correct absolutePath, relativePath, segment, and language for each file', async () => {
      // Arrange
      const config = makeConfig('.', { segments: [{ name: 'mini', root: MINI_REPO, include: ['alpha.ts'] }] });

      // Act
      const files = await collect(walkSegments(config, '/'));

      // Assert
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        absolutePath: resolve(MINI_REPO, 'alpha.ts'),
        relativePath: 'alpha.ts',
        segment: 'mini',
        language: 'typescript',
      });
    });

    it('assigns language based on file extension', async () => {
      // Arrange
      const config = makeConfig(MINI_REPO, {
        segments: [{
          name: 'src',
          root: MINI_REPO,
          include: ['alpha.ts', 'beta.tsx', 'script.js', 'readme.md'],
        }],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const byName = Object.fromEntries(files.map(f => [f.relativePath, f.language]));

      // Assert
      expect(byName['alpha.ts']).toBe('typescript');
      expect(byName['beta.tsx']).toBe('typescript');
      expect(byName['script.js']).toBe('javascript');
      expect(byName['readme.md']).toBe('markdown');
    });
  });

  describe('include patterns', () => {
    it('returns only files that match include globs', async () => {
      // Arrange — include only .ts files, not .js or .md
      const config = makeConfig(MINI_REPO, {
        segments: [{ name: 'src', root: MINI_REPO, include: ['**/*.ts'] }],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const names = files.map(f => f.relativePath);

      // Assert — alpha.ts and alpha.test.ts match *.ts (no exclude yet)
      expect(names.every(n => n.endsWith('.ts'))).toBe(true);
      expect(names).not.toContain('script.js');
      expect(names).not.toContain('readme.md');
    });
  });

  describe('exclude patterns', () => {
    it('skips files matching config exclude patterns', async () => {
      // Arrange
      const config = makeConfig(MINI_REPO, {
        segments: [{ name: 'src', root: MINI_REPO, include: ['**/*.{ts,tsx,js,md}'] }],
        exclude: ['**/*.test.ts'],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const names = files.map(f => f.relativePath);

      // Assert
      expect(names).not.toContain('alpha.test.ts');
      expect(names).toContain('alpha.ts');
    });
  });

  describe('always-excluded files', () => {
    it('never returns lockfiles even if include pattern would match', async () => {
      // Arrange — broad include catches everything
      const config = makeConfig(MINI_REPO, {
        segments: [{ name: 'src', root: MINI_REPO, include: ['**/*'] }],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const names = files.map(f => f.relativePath);

      // Assert
      expect(names).not.toContain('package-lock.json');
    });

    it('never returns binary files (images) even if include pattern would match', async () => {
      // Arrange
      const config = makeConfig(MINI_REPO, {
        segments: [{ name: 'src', root: MINI_REPO, include: ['**/*'] }],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const names = files.map(f => f.relativePath);

      // Assert
      expect(names).not.toContain('image.png');
    });
  });

  describe('multiple segments', () => {
    it('yields files from all segments with correct segment names', async () => {
      // Arrange — two segments pointing at the same fixture dir but different names
      const config: RagConfig = {
        segments: [
          { name: 'alpha-seg', root: MINI_REPO, include: ['alpha.ts'] },
          { name: 'beta-seg', root: MINI_REPO, include: ['beta.tsx'] },
        ],
        exclude: [],
        embedder: { provider: 'local', model: 'test' },
        chunk: { maxTokens: 512, overlapLines: 8 },
        store: { path: '.rag/index.db' },
      };

      // Act
      const files = await collect(walkSegments(config, '/'));

      // Assert
      expect(files).toHaveLength(2);
      expect(files.find(f => f.relativePath === 'alpha.ts')?.segment).toBe('alpha-seg');
      expect(files.find(f => f.relativePath === 'beta.tsx')?.segment).toBe('beta-seg');
    });
  });

  describe('.gitignore support', () => {
    let tmpDir: string;

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('skips files listed in .gitignore', async () => {
      // Arrange — build temp repo with .gitignore
      tmpDir = await mkdtemp(join(tmpdir(), 'rag-mcp-test-'));
      await writeFile(join(tmpDir, '.gitignore'), 'secret.ts\n');
      await writeFile(join(tmpDir, 'secret.ts'), 'export const secret = true;\n');
      await writeFile(join(tmpDir, 'public.ts'), 'export const pub = true;\n');

      const config = makeConfig(tmpDir, {
        segments: [{ name: 'src', root: tmpDir, include: ['**/*.ts'] }],
      });

      // Act
      const files = await collect(walkSegments(config, '/'));
      const names = files.map(f => f.relativePath);

      // Assert
      expect(names).toContain('public.ts');
      expect(names).not.toContain('secret.ts');
    });
  });
});
