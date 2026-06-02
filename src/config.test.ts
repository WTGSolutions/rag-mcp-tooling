import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, ConfigError } from './config.js';

const FIXTURES = join(import.meta.dirname, '__fixtures__');

describe('loadConfig', () => {
  describe('valid config', () => {
    it('loads full valid config and returns typed object', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.valid.json');

      // Act
      const config = loadConfig(path);

      // Assert
      expect(config.segments).toHaveLength(3);
      expect(config.segments[0]).toEqual({ name: 'web', root: 'web/src', include: ['**/*.{ts,tsx}'] });
      expect(config.exclude).toEqual(['**/node_modules/**', '**/*.test.ts', '**/dist/**']);
      expect(config.embedder.provider).toBe('local');
      expect(config.embedder.model).toBe('Xenova/bge-small-en-v1.5');
      expect(config.chunk.maxTokens).toBe(512);
      expect(config.chunk.overlapLines).toBe(8);
      expect(config.store.path).toBe('.rag/index.db');
    });

    it('applies defaults for all optional fields when only segments provided', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.minimal.json');

      // Act
      const config = loadConfig(path);

      // Assert
      expect(config.exclude).toEqual([]);
      expect(config.embedder.provider).toBe('local');
      expect(config.embedder.model).toBe('Xenova/bge-small-en-v1.5');
      expect(config.chunk.maxTokens).toBe(512);
      expect(config.chunk.overlapLines).toBe(8);
      expect(config.store.path).toBe('.rag/index.db');
    });

    it('applies field-level defaults when chunk is partially specified', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.partial-chunk.json');

      // Act
      const config = loadConfig(path);

      // Assert — overlapLines from fixture, maxTokens falls back to default
      expect(config.chunk.overlapLines).toBe(4);
      expect(config.chunk.maxTokens).toBe(512);
    });

    it('returns independent exclude array — mutating it does not affect defaults', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.minimal.json');

      // Act
      const config = loadConfig(path);
      config.exclude.push('injected');
      const config2 = loadConfig(path);

      // Assert — second load still returns fresh empty array
      expect(config2.exclude).toEqual([]);
    });
  });

  describe('default fallbacks for invalid values', () => {
    it('falls back to defaults when chunk values are negative or non-integer', () => {
      // Arrange — maxTokens: -1, overlapLines: 3.7
      const path = join(FIXTURES, 'rag.config.invalid-chunk.json');

      // Act
      const config = loadConfig(path);

      // Assert
      expect(config.chunk.maxTokens).toBe(512);
      expect(config.chunk.overlapLines).toBe(8);
    });

    it('falls back to default store path when path is an empty string', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.empty-path.json');

      // Act
      const config = loadConfig(path);

      // Assert
      expect(config.store.path).toBe('.rag/index.db');
    });
  });

  describe('validation errors', () => {
    it('throws ConfigError when file does not exist', () => {
      // Arrange
      const path = '/nonexistent/rag.config.json';

      // Act + Assert
      expect(() => loadConfig(path)).toThrow(ConfigError);
      expect(() => loadConfig(path)).toThrow('Cannot read config file');
    });

    it('preserves the original error as cause when file cannot be read', () => {
      // Arrange
      const path = '/nonexistent/rag.config.json';

      // Act
      let caught: unknown;
      try { loadConfig(path); } catch (e) { caught = e; }

      // Assert
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).cause).toBeTruthy();
    });

    it('throws ConfigError when file is not valid JSON', () => {
      // Arrange — config.ts is a valid file but not JSON
      const tsPath = join(import.meta.dirname, 'config.ts');

      // Act + Assert
      expect(() => loadConfig(tsPath)).toThrow(ConfigError);
      expect(() => loadConfig(tsPath)).toThrow('not valid JSON');
    });

    it('preserves the SyntaxError as cause when JSON is malformed', () => {
      // Arrange
      const tsPath = join(import.meta.dirname, 'config.ts');

      // Act
      let caught: unknown;
      try { loadConfig(tsPath); } catch (e) { caught = e; }

      // Assert
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).cause).toBeInstanceOf(SyntaxError);
    });

    it('throws ConfigError with clear message when segments key is absent', () => {
      // Arrange — fixture has valid JSON but no "segments" key
      const path = join(FIXTURES, 'rag.config.no-segments.json');

      // Act + Assert
      expect(() => loadConfig(path)).toThrow(ConfigError);
      expect(() => loadConfig(path)).toThrow('"segments" is required');
    });

    it('throws ConfigError when segments is empty array', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.empty-segments.json');

      // Act + Assert
      expect(() => loadConfig(path)).toThrow(ConfigError);
      expect(() => loadConfig(path)).toThrow('"segments" must contain at least one entry');
    });

    it('throws ConfigError when segment is missing required name field', () => {
      // Arrange
      const path = join(FIXTURES, 'rag.config.bad-segment.json');

      // Act + Assert
      expect(() => loadConfig(path)).toThrow(ConfigError);
      expect(() => loadConfig(path)).toThrow('segments[0].name');
    });
  });
});
