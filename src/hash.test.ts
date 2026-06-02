import { describe, it, expect } from 'vitest';
import { sha1 } from './hash.js';

describe('sha1', () => {
  it('returns a 40-character hex digest', () => {
    // Arrange + Act
    const digest = sha1('hello');

    // Assert
    expect(digest).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is deterministic — same input produces same digest', () => {
    // Arrange + Act + Assert
    expect(sha1('const x = 1;')).toBe(sha1('const x = 1;'));
  });

  it('produces different digests for different input', () => {
    // Arrange + Act + Assert
    expect(sha1('a')).not.toBe(sha1('b'));
  });

  it('matches the known SHA-1 of an empty string', () => {
    // Arrange + Act + Assert — well-known constant
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});
