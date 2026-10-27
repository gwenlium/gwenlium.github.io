# Brevo newsletter

Email signup uses the website's own themed form and submits to the public endpoint used by Brevo's HTML embed (`?isAjax=1`). Brevo handles list selection, double opt-in, unsubscribes and delivery. The site displays success only after Brevo confirms acceptance, and preserves the entered address on validation, network and timeout errors. No Brevo API key belongs in the site, repository or browser. The shared URL validator accepts only public HTTPS `sibforms.com/serve/…` form URLs; the site CSP allows the configured form's exact origin for requests and ordinary form submission.

## Account setup

1. Use the Brevo Free plan. Verify a sending address and authenticate its domain using the DNS records provided by Brevo. Preserve existing DNS records. The current free allowance is 300 total email sends per day, including confirmation emails.
2. Create a list named **Gwenlium — all updates**.
3. Create a full-page/embedded signup form for that list. Collect the email address, enable double opt-in and configure the confirmation email. The website's heading remains editable in Site settings. The native form includes Brevo's `email_address_check` honeypot and `locale=en` fields. If adding a required field or CAPTCHA in Brevo, update the native form integration too; the direct hosted-form link remains available as a fallback.
4. Set the success message to **Check your inbox and confirm your subscription.** Keep invalid-address and delivery errors visible. Test the complete signup and unsubscribe flow using an address you control.
5. Copy the public form URL from the Share step (`https://…sibforms.com/serve/…`). Set it in **Edit → Site settings → Brevo signup form** (`src/content/site.json` → `newsletterUrl`). Preserve the entire token, including any trailing `=` characters. Empty disables email signup and shows the RSS alternative. The direct hosted-form link is available if requests are blocked. Without JavaScript, ordinary form submission continues on Brevo's hosted page.

## Sender and replies

Use **Gwenlium <info@gwenlium.dev>** as the sender and reply-to for both the double opt-in email and RSS campaigns. The domain uses Dynadot DNS. Configure its free email forwarding for `info` to the owner's chosen inbox, complete destination verification, and add the domain authentication records supplied by Brevo. Keep existing website records intact. Verify forwarding and domain authentication before enabling delivery. Forwarding receives replies; Brevo sends the newsletter emails.

## Automatic updates

In Brevo's account menu, open **Integrations → RSS campaign**:

- Feed: `https://gwenlium.dev/rss.xml`
- List: **Gwenlium — all updates**
- Sender: the verified Gwenlium address
- Schedule: daily, for example 18:00 Europe/Zurich
- Enable automatic sending once the template and first draft have been reviewed.

The feed includes every published entry from Home, Devlog, Life, Gallery, Music, About and Subscribe. Hidden entries and entries whose publication date has not arrived are excluded. Editing a page setting or uploading a file to the private media library does not create a new entry. Brevo checks for new feed items on its schedule; an empty update does not send an email. Review the first campaign before enabling automatic sending so old posts are not accidentally mailed as a backlog.

If moving existing subscribers, export only confirmed, subscribed contacts from the old service and import them into this list, keeping unsubscribes excluded. Complete a test delivery before disabling the old RSS email delivery, so two services do not email the same audience.

## Deployment

Subscriptions are currently paused at the owner's request. All four `subscribe` page windows in `src/content/windows.json` are disabled. With all subscription-page windows disabled, `/subscribe/` redirects home and the page is excluded from navigation, keyboard shortcuts, search and the sitemap. Signup forms elsewhere also stop rendering and the Brevo origin is removed from the site's CSP. The form URL and copy remain saved for later. The Brevo RSS integration must remain **inactive** while paused.

To restore the page, enable the desired subscription-page windows in the website's window editor and publish. Enable `subscribe-email` for email signup and `subscribe-rss` for the RSS panel. Review the first RSS campaign's date range and resume the Brevo integration separately when delivery is wanted.

Run `npm run test:pages` (also verifies a configured Brevo form), `npm run test:auth`, `npm run check`, `npm run build`, and `npm run test:subscribe`. The existing publishing worker accepts the `newsletterUrl` field, so no worker deployment or new secrets are required. Publish the static site with the real form URL through the existing GitHub Pages workflow. Verify signup feedback in Safari and a second browser, and confirm the subscription in Brevo before claiming the migration is live.

References: [Brevo forms](https://help.brevo.com/hc/en-us/articles/208771869-Create-a-sign-up-form-in-Brevo), [RSS campaigns](https://help.brevo.com/hc/en-us/articles/360013130059-RSS-Campaign-integration-Automatically-share-your-blog-posts-with-your-subscribers), [free plan](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).
