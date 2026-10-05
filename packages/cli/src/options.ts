export function validateArguments(args: string[], command: string): void {
  const allowed = command === 'code' ? ['--server'] : command === 'start' ? ['--server'] : ['--server', '--name', '--domain', '--service'];
  const seen = new Set<string>();
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional++; continue; }
    if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}. Run endport --help.`);
    if (seen.has(arg)) throw new Error(`Option ${arg} was provided more than once.`);
    seen.add(arg);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value.`);
    if (arg === '--server') normalizeServer(value);
    if (arg === '--name' && (!/^[a-z][a-z0-9-]{2,30}$/.test(value) || value.endsWith('-'))) throw new Error('--name must contain 3–31 lowercase letters, digits or hyphens and start with a letter.');
    if (arg === '--domain' && !validDomain(value)) throw new Error('--domain needs a hostname, for example api.example.com, without a scheme or path.');
  }
  if (positional > (command === 'start' ? 0 : 1)) throw new Error('Too many arguments. Run endport --help.');
}

export function validDomain(value: string): boolean {
  return value.length <= 253 && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function normalizeServer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Server must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Server must be an HTTP or HTTPS origin without credentials, query or path.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for remote servers to protect your owner credential.');
  return url.origin;
}

export function identityId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid endpoint identity.');
  return value;
}
