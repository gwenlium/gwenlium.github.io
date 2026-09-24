# Admin analytics connection

The owner editor (Edit > Analytics) uses Cloudflare Web Analytics aggregates. The beacon is configured for gwenlium.dev; the API credential is stored separately in the Worker secret store. An empty report is only shown after a successful provider response; missing configuration and upstream errors are not reported as zero traffic.

## Activation

1. Sign into the existing Cloudflare account and create or select the Web Analytics property for `gwenlium.dev`. Use manual beacon installation for this GitHub Pages site. Do not enable both automatic and manual injection.
2. Save its public beacon token in `src/content/analytics.json`. This is a public collection identifier, not an API credential. The public-site layout loads the beacon once, with Cloudflare's automatic SPA support; the owner's writing page `/write/` has no beacon.
3. Set `CF_ANALYTICS_ACCOUNT_ID` to the matching account. Reports are restricted to the exact hostname from `SITE_ORIGIN` (gwenlium.dev). No property-list or Account Settings permission is needed, and the public beacon token is never treated as a site tag.
4. Create a read-only Account Analytics token scoped to this account. Store it only as the `CF_ANALYTICS_API_TOKEN` Worker secret, using `wrangler secret put CF_ANALYTICS_API_TOKEN --config admin-auth/wrangler.jsonc`. Never add it to the repository or browser configuration.
5. Run `npm run test:auth`, `npm run check`, and `npm run build`, then deploy the existing Worker with `wrangler deploy --config admin-auth/wrangler.jsonc`. Preserve its existing OAuth secrets and variables. Push the static site changes through the normal Pages workflow.
6. Sign in on the website (Ctrl+Alt+E), open Edit > Analytics, and verify the 1/7/30-day reports against the Cloudflare property. Confirm the live GraphQL schema supports the RUM query and that permissions permit access; the isolated tests mock the provider and do not replace this live acceptance check.

The Worker verifies the existing owner GitHub App token and its repository installation on every report. The Cloudflare credential stays server-side. Reports allow only the configured site origin, fixed account, fixed hostname, and bounded date ranges; responses are never cached publicly. Closing the panel clears its visible results.

Visits are arrivals from an external referrer or direct link, not unique people. Counts can be sampled, delayed, or blocked by a visitor's browser. Collection starts on activation; historical visits cannot be recovered. No custom cookies, visitor identifiers, or session recordings are added.

References: https://developers.cloudflare.com/web-analytics/about/ and https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
