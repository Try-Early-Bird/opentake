import { containsCredentialEcho } from './credential-echo';
import type { DataSourceInspection, InspectedSourceField } from '../../shared/data-sources';

const sensitive = /(?:password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key)/i;
/** A bounded sample projection, not a schema guarantee or a raw response export. */
export function inspectSourceResponse(body: unknown, secrets: readonly string[] = []): DataSourceInspection {
  const fields: InspectedSourceField[] = [];
  let visited = 0, truncated = false;
  function visit(value: unknown, path: string[]) {
    if (++visited > 512 || fields.length >= 64 || path.length > 8) { truncated = true; return; }
    if (path.some(key => sensitive.test(key) || secrets.some(secret => secret.length > 0 && key.includes(secret)) || ['__proto__', 'prototype', 'constructor'].includes(key))) return;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type === 'object') {
      for (const key of Object.keys(value as object)) {
        if (visited > 512 || fields.length >= 64) { truncated = true; break; }
        if (!key.length || key.length > 80) { truncated = true; continue; }
        visit((value as Record<string, unknown>)[key], [...path, key]);
      }
      return;
    }
    if (!path.length || !['string', 'number', 'boolean', 'null', 'array'].includes(type)) { truncated = true; return; }
    let sample: string | number | boolean | null = null;
    if (type === 'array') sample = `${(value as unknown[]).length} items`;
    else if (typeof value === 'string') {
      // Also suppress echoed authentication values even under an innocent field name.
      if (secrets.some(secret => secret.length > 0 && value.includes(secret))) return;
      sample = value.length > 160 ? value.slice(0, 160) + '…' : value;
    } else if (typeof value === 'number') { if (!Number.isFinite(value) || containsCredentialEcho(value, secrets)) return; sample = value; }
    else if (typeof value === 'boolean') sample = value;
    fields.push({ path, type: type as InspectedSourceField['type'], sample, selectable: type !== 'array' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Use a JSON object response; array feeds require an explicit item mapping');
  visit(body, []);
  return { fields, truncated, inferredFrom: 'single-response' };
}
