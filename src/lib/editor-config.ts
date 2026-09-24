/** Where the owner editor signs in and publishes. The worker only accepts requests from siteOrigin. */
export const editorConfig = {
  authOrigin: 'https://gwenlium-cms-auth.gwenlium.workers.dev',
  siteOrigin: 'https://gwenlium.dev',
} as const;

/** The dev server serves a local stand-in for the worker here (scripts/dev-editor.mjs). */
export const devEditorPath = '/__owner-editor';

/** A non-secret hint that this browser has signed in before, so pages load the editor for the owner only. */
export const ownerHintKey = 'gwenlium:owner';
