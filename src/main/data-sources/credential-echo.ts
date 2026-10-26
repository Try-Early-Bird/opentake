/** Request-scoped only: never cache or expose these values outside the host. */
export function credentialEchoValues(auth?: { kind: string; value: string }): string[] {
  if (!auth) return [];
  const values = [auth.value];
  if (auth.kind === 'basic') {
    const decoded = Buffer.from(auth.value, 'base64').toString('utf8');
    values.push(decoded, decoded.slice(decoded.indexOf(':') + 1));
  }
  return values.filter(value => value.length > 0);
}
export function containsCredentialEcho(value: unknown, secrets: readonly string[]): boolean {
  if (!secrets.length || value === null || value === undefined) return false;
  if (typeof value !== 'object') return secrets.some(secret => String(value).includes(secret));
  return Object.entries(value).some(([key, entry]) => secrets.some(secret => key.includes(secret)) || containsCredentialEcho(entry, secrets));
}
