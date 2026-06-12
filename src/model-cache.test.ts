import { describe, it, expect, afterEach } from 'vitest';
import { sep } from 'node:path';
import { modelCacheDir, offlineLoadError, remoteModelsAllowed } from './model-cache.js';

afterEach(() => {
  delete process.env['RAG_ALLOW_DOWNLOAD'];
  delete process.env['RAG_MODEL_CACHE'];
});

describe('remoteModelsAllowed', () => {
  it('is false by default (offline-by-default policy)', () => {
    // Arrange
    delete process.env['RAG_ALLOW_DOWNLOAD'];

    // Act + Assert
    expect(remoteModelsAllowed()).toBe(false);
  });

  it('is true only for the explicit opt-in value "1"', () => {
    process.env['RAG_ALLOW_DOWNLOAD'] = '1';
    expect(remoteModelsAllowed()).toBe(true);

    process.env['RAG_ALLOW_DOWNLOAD'] = 'true'; // anything but "1" stays offline
    expect(remoteModelsAllowed()).toBe(false);

    process.env['RAG_ALLOW_DOWNLOAD'] = '0';
    expect(remoteModelsAllowed()).toBe(false);
  });
});

describe('modelCacheDir', () => {
  it('honors the RAG_MODEL_CACHE override', () => {
    process.env['RAG_MODEL_CACHE'] = `${sep}tmp${sep}rag-cache`;
    expect(modelCacheDir()).toBe(`${sep}tmp${sep}rag-cache`);
  });

  it('defaults to a user-level cache path', () => {
    delete process.env['RAG_MODEL_CACHE'];
    expect(modelCacheDir()).toContain(`.cache${sep}rag-mcp${sep}models`);
  });
});

describe('offlineLoadError', () => {
  it('names the model, the opt-in flag, and the underlying cause', () => {
    // Act
    const err = offlineLoadError('Xenova/bge-m3', new Error('file not found'));

    // Assert
    expect(err.message).toContain('Xenova/bge-m3');
    expect(err.message).toContain('RAG_ALLOW_DOWNLOAD=1');
    expect(err.message).toContain('file not found');
    expect(err.message).toContain('[rag-mcp]');
  });
});
