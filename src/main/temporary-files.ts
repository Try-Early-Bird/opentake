import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** Profile folders that hold per-run CLI homes. Some carry plaintext provider auth files
 *  (ChatGPT/Grok auth.json, login homes) that each run deletes in `finally`; a crash or
 *  force-quit skips that, so the host clears them all before anything else starts. */
export const temporaryRoots = ['chat-temporary', 'ai-login-temporary', 'grok-temporary', 'grok-test-temporary', 'model-discovery-temporary', 'coinbase-temporary', 'mcp-temporary'] as const;

/** Only the single host instance may call this: it owns every run that uses these folders.
 *  `rm` removes a symlinked root as a link and never follows links inside. */
export function sweepTemporaryRoots(profile: string, report: (error: unknown) => void = () => {}) {
  for (const name of temporaryRoots) {
    try { rmSync(join(profile, name), { recursive: true, force: true, maxRetries: 2 }); }
    catch (error) { report(error); }
  }
}
