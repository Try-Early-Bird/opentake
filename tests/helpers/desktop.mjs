import assert from 'node:assert/strict';
import { once } from 'node:events';

// Observe the launched process itself: Playwright's application close event can
// be lost when Electron tears down its debugger during quit on Linux/Windows.
export async function closeDesktop(application, timeoutMs = globalThis.process.platform === 'win32' ? 30_000 : 15_000) {
  const process = application.process();
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit', { signal: AbortSignal.timeout(timeoutMs) });
  // Quitting can detach the debugger before evaluate acknowledges the request.
  // Once the OS process exited, that reply is no longer a cleanup prerequisite.
  const quit = application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  try {
    const [code, signal] = await Promise.race([exited, quit.then(() => exited)]);
    assert.equal(signal, null, 'Desktop must quit without a forced kill');
    assert.equal(code, 0, 'Desktop must exit successfully');
  } catch (error) {
    // A failing test must not leave its own launched child holding the test
    // worker open forever. Preserve the failure; forced cleanup is never a pass.
    if (process.exitCode === null && process.signalCode === null) {
      const stopped = once(process, 'exit', { signal: AbortSignal.timeout(5000) });
      process.kill('SIGKILL');
      await stopped;
    }
    throw error;
  }
}
