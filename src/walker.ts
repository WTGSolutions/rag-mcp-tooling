import { globby } from 'globby';
import { resolve, extname } from 'node:path';
import type { RagConfig, RagSegment } from './config.js';

export type FileLanguage = 'typescript' | 'javascript' | 'markdown' | 'unknown';

export type WalkedFile = {
  absolutePath: string;
  relativePath: string;
  segment: string;
  language: FileLanguage;
};

// Always excluded regardless of config — never index binaries or lockfiles
export const ALWAYS_EXCLUDE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  // lockfiles
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.lock',
  // images
  '**/*.{png,jpg,jpeg,gif,webp,avif,ico,bmp,tiff,svg}',
  // fonts
  '**/*.{woff,woff2,ttf,eot,otf}',
  // audio/video
  '**/*.{mp3,wav,ogg,mp4,webm,mov,avi}',
  // archives
  '**/*.{zip,tar,gz,bz2,rar,7z}',
  // compiled/binary
  '**/*.{pdf,bin,exe,dll,so,dylib,node,wasm}',
  // source maps
  '**/*.map',
];

export function detectLanguage(filePath: string): FileLanguage {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.md':
    case '.mdx':
      return 'markdown';
    default:
      return 'unknown';
  }
}

export async function* walkSegments(
  config: RagConfig,
  cwd = process.cwd(),
): AsyncGenerator<WalkedFile> {
  for (const segment of config.segments) {
    yield* walkSegment(segment, config.exclude, cwd);
  }
}

async function* walkSegment(
  segment: RagSegment,
  globalExclude: readonly string[],
  cwd: string,
): AsyncGenerator<WalkedFile> {
  const segmentRoot = resolve(cwd, segment.root);

  const relativePaths = await globby(segment.include, {
    cwd: segmentRoot,
    absolute: false,
    dot: true,
    gitignore: true,
    ignore: [...ALWAYS_EXCLUDE, ...globalExclude],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  for (const relativePath of relativePaths.sort()) {
    yield {
      absolutePath: resolve(segmentRoot, relativePath),
      relativePath,
      segment: segment.name,
      language: detectLanguage(relativePath),
    };
  }
}
