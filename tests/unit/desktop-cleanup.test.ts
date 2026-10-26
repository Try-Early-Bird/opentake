import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { closeDesktop } from '../helpers/desktop.mjs';

function fixture(evaluate: () => Promise<void>) {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
  return { application: { process: () => child, evaluate: vi.fn(evaluate) },
    exit(code = 0, signal: string | null = null) { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); } };
}

test('desktop cleanup completes on process exit when debugger never acknowledges quit', async () => {
  const f = fixture(() => new Promise<void>(() => {}));
  const cleanup = closeDesktop(f.application);
  f.exit();
  await cleanup;
  expect(f.application.evaluate).toHaveBeenCalledOnce();
});

test('debugger acknowledgment alone does not complete desktop cleanup', async () => {
  const f = fixture(async () => {});
  let finished = false;
  const cleanup = closeDesktop(f.application).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false);
  f.exit(); await cleanup; expect(finished).toBe(true);
});

test('desktop cleanup still rejects an unsuccessful or forced exit', async () => {
  for (const [code, signal] of [[1, null], [0, 'SIGKILL']] as const) {
    const f = fixture(() => new Promise<void>(() => {}));
    const cleanup = closeDesktop(f.application);
    f.exit(code, signal);
    await expect(cleanup).rejects.toThrow(/Desktop must/);
  }
});


test('a shutdown timeout kills only the launched child and remains a test failure', async () => {
  const f = fixture(() => new Promise<void>(() => {}));
  const child = f.application.process();
  const kill = vi.fn(signal => { f.exit(0, signal); return true; });
  Object.assign(child, { kill });
  await expect(closeDesktop(f.application, 10)).rejects.toMatchObject({ name: 'AbortError' });
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
});
