import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export type RagSegment = {
  name: string;
  root: string;
  include: string[];
};

export type RagEmbedderConfig = {
  provider: 'local';
  model: string;
};

export type RagChunkConfig = {
  maxTokens: number;
  overlapLines: number;
};

export type RagStoreConfig = {
  path: string;
};

export type RagConfig = {
  segments: RagSegment[];
  exclude: string[];
  embedder: RagEmbedderConfig;
  chunk: RagChunkConfig;
  store: RagStoreConfig;
};

const DEFAULTS = {
  exclude: [] as string[],
  embedder: { provider: 'local' as const, model: 'Xenova/bge-small-en-v1.5' },
  chunk: { maxTokens: 512, overlapLines: 8 },
  store: { path: '.rag/index.db' },
} as const;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`[rag-mcp] Config error: ${message}`, options);
    this.name = 'ConfigError';
  }
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

// NaN satisfies typeof === 'number', so we guard with isFinite + isInteger
function asPositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : undefined;
}

function asNonNegativeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function validateSegment(seg: unknown, index: number): RagSegment {
  if (typeof seg !== 'object' || seg === null) {
    throw new ConfigError(`segments[${index}] must be an object`);
  }
  const s = seg as Record<string, unknown>;

  if (typeof s['name'] !== 'string' || s['name'].trim() === '') {
    throw new ConfigError(`segments[${index}].name must be a non-empty string`);
  }
  if (typeof s['root'] !== 'string' || s['root'].trim() === '') {
    throw new ConfigError(`segments[${index}].root must be a non-empty string`);
  }
  if (!Array.isArray(s['include']) || s['include'].length === 0) {
    throw new ConfigError(`segments[${index}].include must be a non-empty array of glob patterns`);
  }
  for (const pattern of s['include'] as unknown[]) {
    if (typeof pattern !== 'string') {
      throw new ConfigError(`segments[${index}].include entries must be strings`);
    }
  }

  return {
    name: s['name'] as string,
    root: s['root'] as string,
    include: s['include'] as string[],
  };
}

/**
 * Resolves the store path to an absolute path, anchored at the config file's
 * directory (not the shell cwd). Shared by the CLI and the MCP server so a
 * relative `store.path` always points at the same database regardless of where
 * the command was invoked.
 */
export function resolveStorePath(configPath: string, config: RagConfig): string {
  return resolve(dirname(resolve(configPath)), config.store.path);
}

export function loadConfig(configPath: string): RagConfig {
  const resolved = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file: ${resolved}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config file is not valid JSON: ${resolved}`, { cause: e });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError('Config must be a JSON object');
  }

  const cfg = parsed as Record<string, unknown>;

  if (!Array.isArray(cfg['segments'])) {
    throw new ConfigError('"segments" is required and must be an array');
  }
  if ((cfg['segments'] as unknown[]).length === 0) {
    throw new ConfigError('"segments" must contain at least one entry');
  }

  const segments = (cfg['segments'] as unknown[]).map((seg, i) => validateSegment(seg, i));

  const exclude: string[] = Array.isArray(cfg['exclude'])
    ? (cfg['exclude'] as unknown[]).map((e, i) => {
        if (typeof e !== 'string') throw new ConfigError(`exclude[${i}] must be a string`);
        return e;
      })
    : [...DEFAULTS.exclude];

  const re = typeof cfg['embedder'] === 'object' && cfg['embedder'] !== null
    ? (cfg['embedder'] as Record<string, unknown>)
    : null;
  const embedder: RagEmbedderConfig = re
    ? { provider: 'local', model: asNonEmptyString(re['model']) ?? DEFAULTS.embedder.model }
    : { ...DEFAULTS.embedder };

  const rc = typeof cfg['chunk'] === 'object' && cfg['chunk'] !== null
    ? (cfg['chunk'] as Record<string, unknown>)
    : null;
  const chunk: RagChunkConfig = rc
    ? {
        maxTokens: asPositiveInt(rc['maxTokens']) ?? DEFAULTS.chunk.maxTokens,
        overlapLines: asNonNegativeInt(rc['overlapLines']) ?? DEFAULTS.chunk.overlapLines,
      }
    : { ...DEFAULTS.chunk };

  const rs = typeof cfg['store'] === 'object' && cfg['store'] !== null
    ? (cfg['store'] as Record<string, unknown>)
    : null;
  const store: RagStoreConfig = rs
    ? { path: asNonEmptyString(rs['path']) ?? DEFAULTS.store.path }
    : { ...DEFAULTS.store };

  return { segments, exclude, embedder, chunk, store };
}
