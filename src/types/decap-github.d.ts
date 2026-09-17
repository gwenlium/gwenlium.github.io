// The pinned backend package ships JavaScript without public declarations.
declare module 'decap-cms-backend-github' {
  export interface GitFile { path: string; raw?: string; sha?: string; toBase64?: () => Promise<string> }
  export interface Entry { dataFiles: GitFile[]; assets: Array<{ path: string }> }
  export interface PersistOptions { commitMessage: string; useWorkflow?: boolean; [key: string]: unknown }
  export interface GitHubAPI {
    getDefaultBranch(): Promise<{ commit: { sha: string } }>;
    readFile(path: string, sha?: string | null, options?: { branch?: string; parseText?: boolean }): Promise<string | Blob>;
    uploadBlob(file: GitFile): Promise<GitFile>;
    updateTree(baseSha: string, files: Array<{ path: string; sha: string | null }>): Promise<{ parentSha: string; sha: string }>;
    commit(message: string, tree: { parentSha: string; sha: string }): Promise<{ sha: string }>;
    patchBranch(branch: string, sha: string, options?: { force?: boolean }): Promise<unknown>;
  }
  export class GitHubBackend {
    constructor(config: unknown, options?: unknown);
    api: GitHubAPI | null;
    token: string | null;
    branch: string;
    persistEntry(entry: Entry, options: PersistOptions): Promise<unknown>;
    persistMedia(file: unknown, options: PersistOptions): Promise<unknown>;
    deleteFiles(paths: string[], message: string): Promise<unknown>;
    logout(): unknown;
  }
}
