import { chatLimits } from '../shared/chat-limits';
export class RunLimitError extends Error {}
export const runLimits = { inferenceMs: 1_200_000, absoluteMs: 1_800_000, approvalMs: 120_000, toolMs: 60_000, gatewayMs: 210_000 } as const;

// Approval waits pause inference time, but never extend the absolute ceiling.
/** Per-run limits; rule agent runs set their own, chat uses `runLimits`. */
export interface RunLimits { inferenceMs: number; absoluteMs: number; toolCalls?: number; modelTurns?: number }
export function createRunBudget(parent: AbortSignal, limits: RunLimits = runLimits) {
  const toolCalls = limits.toolCalls ?? chatLimits.toolDispatches;
  const controller = new AbortController();
  const deadline = Date.now() + limits.absoluteMs;
  let remaining = limits.inferenceMs;
  let started = Date.now();
  let waiting = 0;
  let dispatches = 0;
  let finished = false;
  let inference: ReturnType<typeof setTimeout> | undefined;
  const abort = (message: string) => { if (!finished) controller.abort(new RunLimitError(message)); };
  const schedule = () => {
    started = Date.now();
    inference = setTimeout(() => abort('Response exceeded its inference time limit.'), Math.max(0, remaining));
  };
  const cancelled = () => controller.abort(parent.reason);
  const absolute = setTimeout(() => abort('Response reached its overall time limit.'), limits.absoluteMs);
  parent.addEventListener('abort', cancelled, { once: true });
  if (parent.aborted) cancelled();
  schedule();
  return {
    signal: controller.signal,
    cancel(reason: Error = new Error('Response ended.')) { controller.abort(reason); },
    toolDispatch() {
      controller.signal.throwIfAborted();
      if (++dispatches > toolCalls) { controller.abort(new RunLimitError(`Response reached its ${toolCalls} tool-call limit.`)); controller.signal.throwIfAborted(); }
    },
    remainingMs: () => Math.max(0, deadline - Date.now()),
    pause() {
      controller.signal.throwIfAborted();
      if (finished) throw new Error('Run finished.');
      if (waiting++ === 0) { remaining -= Date.now() - started; clearTimeout(inference); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--waiting === 0 && !finished && !controller.signal.aborted) schedule();
      };
    },
    finish() { finished = true; clearTimeout(absolute); clearTimeout(inference); parent.removeEventListener('abort', cancelled); },
  };
}
export type RunBudget = ReturnType<typeof createRunBudget>;
