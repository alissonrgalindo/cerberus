import { Project, ts, type SourceFile } from 'ts-morph';

/**
 * Parses in-memory source into a ts-morph SourceFile without touching disk.
 * The agent may have edited a staged file, so we always analyze the passed
 * content, never re-read from the filesystem.
 */
export function createSourceFile(filePath: string, content: string): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
    },
  });
  return project.createSourceFile(filePath, content, { overwrite: true });
}
