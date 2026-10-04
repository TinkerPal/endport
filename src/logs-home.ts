export {};

const form = document.querySelector<HTMLFormElement>('#code-form')!;
const input = document.querySelector<HTMLInputElement>('#code-input')!;
const error = document.querySelector<HTMLElement>('#code-error')!;
const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

if (local) {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="https://endport.io/"]').forEach((link) => {
    link.href = new URL(link.pathname, location.origin).href;
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const code = input.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}-?[A-Z0-9]{5}$/.test(code)) { error.textContent = 'Enter the 10-character code printed by your CLI.'; return; }
  const button = form.querySelector<HTMLButtonElement>('button')!;
  button.disabled = true;
  try {
    const response = await fetch('/api/logs/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const result = await response.json() as { workspaceUrl?: string; error?: string };
    if (!response.ok || !result.workspaceUrl) throw new Error(result.error ?? 'Unable to unlock the workspace.');
    location.assign(result.workspaceUrl);
  } catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Unable to open logs.'; }
  finally { button.disabled = false; }
});
