# Brevo newsletter

Email signup uses Brevo's hosted form inside an iframe. Brevo handles email validation, success/error feedback, double opt-in, unsubscribes and delivery. No Brevo API key belongs in the site, repository or browser. The shared URL validator accepts only a public HTTPS `sibforms.com/serve/…` form URL, and the site CSP permits only that form's exact origin as a frame.

## Account setup

1. Use the Brevo Free plan. Verify a sending address and authenticate its domain using the DNS records provided by Brevo. Preserve existing DNS records. The current free allowance is 300 total email sends per day, including confirmation emails.
2. Create a list named **Gwenlium — all updates**.
3. Create a full-page/embedded signup form for that list. Collect the email address, enable double opt-in and configure the confirmation email. Set the form's heading and button text in Brevo; the website's separate heading remains editable in Site settings. Use a responsive form and configure the provider's spam protection.
4. Set the success message to **Check your inbox and confirm your subscription.** Keep invalid-address and delivery errors visible. Test the complete signup and unsubscribe flow using an address you control.
5. Copy the public form URL from the Share step (`https://…sibforms.com/serve/…`). Set it in **Edit → Site settings → Brevo signup form** (`src/content/site.json` → `newsletterUrl`). The site uses Brevo's `/v2/serve/…` iframe endpoint automatically; either URL is accepted. Preserve the entire token, including any trailing `=` characters. Empty disables email signup and shows the RSS alternative. There is always a direct link beside the embedded form for browsers that block it.

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

Run `npm run test:pages` (also verifies a configured Brevo embed), `npm run test:auth`, `npm run check`, `npm run build`, and `npm run test:subscribe`. The existing publishing worker accepts the `newsletterUrl` field, so no worker deployment or new secrets are required. Publish the static site with the real form URL through the existing GitHub Pages workflow. Verify the embedded form in Safari and a second browser, and confirm the subscription in Brevo before claiming the migration is live.

References: [Brevo forms](https://help.brevo.com/hc/en-us/articles/208771869-Create-a-sign-up-form-in-Brevo), [RSS campaigns](https://help.brevo.com/hc/en-us/articles/360013130059-RSS-Campaign-integration-Automatically-share-your-blog-posts-with-your-subscribers), [free plan](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).
