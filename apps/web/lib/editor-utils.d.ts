export type EditorStatus = 'draft' | 'public' | 'private';
export function serializeEditorStatus(status: EditorStatus): { status: 'draft' | 'published'; visibility: 'public' | 'private' };
export function deserializeEditorStatus(payload: { status?: string; visibility?: string }): EditorStatus;
export function markdownToEditorHTML(markdown: string): string;
export function editorHTMLToMarkdown(html: string): string;
export function hasUnsupportedStructure(markdown: string): boolean;
export function nextRetryAt(attempts: number, now?: number): number;
export function groupDayEntries<T>(day: { untimed?: T[]; timed?: T[] }): T[];
