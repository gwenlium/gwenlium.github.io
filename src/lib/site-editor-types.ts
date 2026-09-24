export interface EditorOwner { id: number; login: string }
export interface EditorFileInfo { path: string; sha: string; size: number }
export interface EditorSnapshot { head: string; branch: string; repository: string; owner: EditorOwner; files: EditorFileInfo[] }
export interface EditorFile { path: string; sha: string; content: string }
export interface EditorChange { path: string; content: string }
export interface EditorMediaEntry { sha256: string; kind: 'image' | 'video' | 'audio'; width?: number; height?: number; duration?: number }
export interface EditorMediaUpload { path: string; content: string; entry: EditorMediaEntry }
export interface EditorPublishRequest { baseCommit: string; changes: EditorChange[]; media: EditorMediaUpload[] }
export interface EditorPublishResult { commit: string; htmlUrl: string }
export interface EditorBinding { file: string; field: string; format: 'text' | 'markdown' | 'image'; label: string; altField?: string }
export interface EditorDraftFile { path: string; baseContent: string | null; content: string }
export interface EditorConflict { path: string; base: string | null; draft: string; remote: string | null }
// Binding fields are JSON pointers; an @id segment selects an array item by id.
// Markdown documents expose frontmatter fields at the root and /body for Markdown.
// HTTP: GET /editor; GET /editor/file?path=...&ref=<head>; POST /editor/publish.
// All endpoints require the exact site Origin and an owner-verified Bearer token.
