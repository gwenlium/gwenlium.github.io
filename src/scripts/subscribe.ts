// Keep the provider's native POST and its real confirmation/error page.
// Delegation also covers subscribe boxes added by the editor or in-site navigation.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !form.matches('[data-followit-form]')) return;
  const status = form.querySelector<HTMLElement>('[data-followit-status]');
  if (status) status.textContent = 'Opening follow.it… Complete signup there, then check your inbox for a confirmation email.';
});

function resetStatus() {
  for (const status of document.querySelectorAll<HTMLElement>('[data-followit-status]')) status.textContent = '';
}

// Returning with Back must not leave the form saying it is still submitting.
window.addEventListener('pageshow', resetStatus);
document.addEventListener('astro:page-load', resetStatus);
