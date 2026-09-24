import type { APIRoute } from 'astro';

/** Which commit this deployment was built from, so the editor can tell when a publish is live. */
export const GET: APIRoute = () => new Response(JSON.stringify({
  commit: process.env.GITHUB_SHA ?? 'local',
  builtAt: new Date().toISOString(),
}), { headers: { 'Content-Type': 'application/json' } });
