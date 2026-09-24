export interface EditorOwner { id: number; login: string }
export interface EditorFileInfo { path: string; sha: string; size: number }
export interface EditorSnapshot { head: string; branch: string; repository: string; owner: EditorOwner; files: EditorFileInfo[] }
export interface EditorFile { path: string; sha: string; content: string }
export interface EditorChange { path: string; content: string }
export interface EditorMediaEntry { sha256: string; kind: 'image' | 'video' | 'audio'; width?: number; height?: number; duration?: number }
/** A prepared file the browser already uploaded to GitHub: `blob` is its Git blob SHA, `size` its bytes. */
export interface EditorMediaUpload { path: string; blob: string; size: number; entry: EditorMediaEntry }
export interface EditorPublishRequest { baseCommit: string; changes: EditorChange[]; media: EditorMediaUpload[]; deletions?: string[]; message?: string }
export interface EditorPublishResult { commit: string; htmlUrl: string }
export interface EditorBinding { file: string; field: string; format: 'text' | 'markdown' | 'image'; label: string; altField?: string }
export interface EditorDraftFile { path: string; baseContent: string | null; content: string; deleted?: boolean }
export interface EditorConflict { path: string; base: string | null; draft: string; remote: string | null }
// Binding fields are JSON pointers; an @id segment selects an array item by id.
// Markdown documents expose frontmatter fields at the root and /body for Markdown.
// HTTP: GET /editor; GET /editor/file?path=...&ref=<head>; POST /editor/publish.
// All endpoints require the exact site Origin and an owner-verified Bearer token.
export interface PreviewRegistry { files: Record<string, EditorMediaEntry> }
