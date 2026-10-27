import { brevoFormUrl } from '../lib/newsletter.mjs';

function initSubscribeForms() {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-brevo-form]')) {
    if (form.dataset.subscribeBound) continue;
    form.dataset.subscribeBound = 'true';
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form.querySelector<HTMLElement>('[data-subscribe-status]');
    if (!button || !status) continue;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled || !form.reportValidity()) return;
      button.disabled = true;
      button.textContent = 'Subscribing…';
      form.setAttribute('aria-busy', 'true');
      status.dataset.state = 'pending';
      status.textContent = 'Sending your signup…';
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      try {
        const endpoint = new URL(brevoFormUrl(form.action));
        endpoint.searchParams.set('isAjax', '1');
        // This is Brevo's public form submission endpoint, also used by its HTML embed.
        // Keep double opt-in, list selection and unsubscribe handling in Brevo.
        const response = await fetch(endpoint, {
          method: 'POST', body: new FormData(form), credentials: 'omit',
          referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || result.success !== true) {
          status.dataset.state = 'error';
          status.textContent = result.errors?.EMAIL
            ? 'Please check your email address and try again.'
            : "We couldn't save your signup. Please try again or use the direct signup link below.";
          return;
        }
        status.dataset.state = 'success';
        status.textContent = 'Check your inbox! Click the confirmation link in the email to finish subscribing to Gwenlium updates.';
        form.reset();
      } catch {
        status.dataset.state = 'error';
        status.textContent = "We couldn't confirm your signup. Please try again or use the direct signup link below.";
      } finally {
        window.clearTimeout(timeout);
        button.disabled = false;
        button.textContent = 'Subscribe';
        form.removeAttribute('aria-busy');
      }
    });
  }
}

initSubscribeForms();
document.addEventListener('astro:page-load', initSubscribeForms);
