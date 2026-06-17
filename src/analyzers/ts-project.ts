import { createHash } from 'node:crypto';
import { Project, ts, type SourceFile } from 'ts-morph';

/**
 * Parses in-memory source into a ts-morph SourceFile without touching disk.
 * The agent may have edited a staged file, so we always analyze the passed
 * content, never re-read from the filesystem.
 *
 * A single shared Project + a per-path content-hash cache means each file is
 * parsed once per run even though many analyzers ask for it — analyzers only
 * read the AST, never mutate it.
 */
let sharedProject: Project | null = null;

const cache = new Map<string, { hash: string; sourceFile: SourceFile }>();

function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ESNext,
      },
    });
  }
  return sharedProject;
}

export function createSourceFile(filePath: string, content: string): SourceFile {
  const hash = createHash('sha1').update(content).digest('hex');
  const cached = cache.get(filePath);
  if (cached && cached.hash === hash) return cached.sourceFile;

  const sourceFile = getProject().createSourceFile(filePath, content, { overwrite: true });
  cache.set(filePath, { hash, sourceFile });
  return sourceFile;
}

/** Test helper: drops the shared project and cache. */
export function resetSourceFileCache(): void {
  sharedProject = null;
  cache.clear();
}
