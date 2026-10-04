const announcement = document.querySelector<HTMLElement>('#copy-announcement');

if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  document.querySelectorAll<HTMLAnchorElement>('[data-logs-link]').forEach((link) => { link.href = '/logs'; });
}

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const command = button.dataset.copy;
    if (!command) return;

    try {
      await navigator.clipboard.writeText(command);

      const label = button.querySelector<HTMLElement>('.copy-label');
      const icon = button.querySelector<HTMLElement>('.copy-icon');

      if (label) label.textContent = 'Copied';
      if (icon) icon.textContent = '✓';
      if (announcement) announcement.textContent = `Copied ${command}`;

      window.setTimeout(() => {
        if (label) label.textContent = 'Copy';
        if (icon) icon.textContent = '▣';
      }, 1800);
    } catch {
      if (announcement) {
        announcement.textContent = 'Copy failed. Select the command and copy it manually.';
      }
    }
  });
});
