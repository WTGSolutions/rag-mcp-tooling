import { createHash } from 'node:crypto';

// Single source of truth for content hashing across the tool.
// Used for chunk ids (chunk-factory) and file hashes (router, TASK-008 reindex).
export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
