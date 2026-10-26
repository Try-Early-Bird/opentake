// The strategy page's write and live-status calls. The local execution layer
// answers them through window.allocations.

export type SellChoice = 'none' | 'all' | string[];

/** A write's answer. */
export type StrategyAuthorResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; message: string; code: string | null };

export type QueueAction = 'cancel' | 'confirm';
export interface QueueItem {
  /** `<source>:<ref>`; the prefix routes an action back to its source. */
  id: string;
  [field: string]: unknown;
}
export type QueueResult =
  | { ok: true; items: QueueItem[] }
  | { ok: false; status: number; message: string };

export interface TradingPreferences {
  confirmTrades: boolean;
  blockedSymbols: string[];
}
export type TradingPreferencesResult =
  | { ok: true; preferences: TradingPreferences }
  | { ok: false; status: number; message: string };

export type PreflightTarget = { strategyId: string } | { bucketId: string };

export interface AllocationActions {
  strategyBuckets: {
    close(bucketId: string, sell: SellChoice): Promise<StrategyAuthorResult>;
    deposit(bucketId: string, amount: string): Promise<StrategyAuthorResult>;
    redemptionPreview(bucketId: string, amount: string): Promise<{ status: number; redemption: unknown | null }>;
    redeem(bucketId: string, amount: string): Promise<StrategyAuthorResult>;
    instructions(bucketId: string): Promise<{ status: number; instructions: unknown[] }>;
    /** Cancels a queued withdrawal; refused once its sells have been sent. */
    cancelInstruction(bucketId: string, instructionId: string): Promise<StrategyAuthorResult>;
    confirmInstruction(bucketId: string, instructionId: string): Promise<StrategyAuthorResult>;
    resolveOutsideSale(bucketId: string, resolution: 'keep' | 'detach'): Promise<StrategyAuthorResult>;
    create(input: {
      strategyId: string;
      financialAccountId: string;
      allocationValue: string;
      confirmationMode?: 'delegated' | 'per_order';
    }): Promise<StrategyAuthorResult>;
    update(bucketId: string, input: { status?: 'active' | 'paused' | 'detached'; allocationValue?: string }): Promise<StrategyAuthorResult>;
    /** Plans now and places what is due. */
    plan(bucketId: string): Promise<StrategyAuthorResult>;
  };
  queue: {
    /** Cancels or confirms one item; answers with the queue as it now stands. */
    act(itemId: string, action: QueueAction): Promise<QueueResult>;
  };
  tradingPreferences: {
    get(): Promise<TradingPreferencesResult>;
  };
  /** What an amount would buy, and anything stopping it, before committing it. */
  getStrategyPreflight(target: PreflightTarget, amount: string): Promise<{ status: number; preflight: unknown | null }>;
  getStrategyActivity(strategyId: string, limit?: number, cursor?: string | null): Promise<{ status: number; events: unknown[]; nextCursor: string | null }>;
}

const unavailable = { ok: false as const, status: 0, message: 'Restart Opentake to finish updating its background service.', code: null };
/** Every call goes to the background host; an older preload without the bridge answers as unavailable. */
function bridge(): typeof window.allocations | null {
  return (window.allocations as typeof window.allocations | undefined)?.holdings === undefined ? null : window.allocations;
}

export const allocationActions: AllocationActions | null = {
  strategyBuckets: {
    close: (bucketId, sell) => bridge()?.close(bucketId, sell) ?? Promise.resolve(unavailable),
    deposit: (bucketId, amount) => bridge()?.deposit(bucketId, amount) ?? Promise.resolve(unavailable),
    redemptionPreview: (bucketId, amount) => bridge()?.redemptionPreview(bucketId, amount) ?? Promise.resolve({ status: 0, redemption: null }),
    redeem: (bucketId, amount) => bridge()?.redeem(bucketId, amount) ?? Promise.resolve(unavailable),
    instructions: (bucketId) => bridge()?.instructions(bucketId) ?? Promise.resolve({ status: 0, instructions: [] }),
    cancelInstruction: (bucketId, instructionId) => bridge()?.cancelInstruction(bucketId, instructionId) ?? Promise.resolve(unavailable),
    confirmInstruction: (bucketId, instructionId) => bridge()?.confirmInstruction(bucketId, instructionId) ?? Promise.resolve(unavailable),
    resolveOutsideSale: (bucketId, resolution) => bridge()?.resolveOutsideSale(bucketId, resolution) ?? Promise.resolve(unavailable),
    create: (input) => bridge()?.create({ strategyId: input.strategyId, financialAccountId: input.financialAccountId, allocationValue: input.allocationValue }) ?? Promise.resolve(unavailable),
    update: (bucketId, input) => bridge()?.update(bucketId, { ...(input.status === undefined ? {} : { status: input.status }) }) ?? Promise.resolve(unavailable),
    plan: (bucketId) => bridge()?.plan(bucketId) ?? Promise.resolve(unavailable),
  },
  queue: {
    act: async (itemId, action) => {
      const result = await (bridge()?.queueAct(itemId, action) ?? Promise.resolve(unavailable));
      return result.ok ? { ok: true, items: result.items as QueueItem[] } : { ok: false, status: result.status, message: result.message };
    },
  },
  tradingPreferences: {
    get: () => bridge()?.tradingPreferences() ?? Promise.resolve(unavailable),
  },
  getStrategyPreflight: (target, amount) => bridge()?.preflight(target, amount) ?? Promise.resolve({ status: 0, preflight: null }),
  getStrategyActivity: (strategyId, limit, cursor) => bridge()?.activity(strategyId, limit, cursor ?? null) ?? Promise.resolve({ status: 0, events: [], nextCursor: null }),
};
