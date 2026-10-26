import { z } from 'zod';
/** Separate authorization from HTTP: exact endpoint, no query credentials. */
export const websocketCredentialSchema = z.object({
  endpoint: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'wss:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash &&
        url.hostname.includes('.') && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':') && !/%|\\/.test(url.pathname);
    } catch { return false; }
  }),
  kind: z.enum(['bearer', 'basic', 'api-key', 'message']),
  value: z.string().min(1).max(2048).refine(value => !/[\r\n]/.test(value)),
  header: z.enum(['X-API-Key', 'API-Key']).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'api-key') !== Boolean(value.header)) ctx.addIssue({ code: 'custom', message: 'API-key credentials require a supported header.' });
  if (value.kind === 'basic' && !/^[A-Za-z0-9+/]+={0,2}$/.test(value.value)) ctx.addIssue({ code: 'custom', message: 'Basic credentials require base64 username:password.' });
});
