// The member's controls over a strategy allocation. Phase 2 covers
// review and resume of imported or restored allocations, and pause; the
// trading instructions (invest, deposit, withdraw, close) join in later phases.

export interface AllocationReview {
 allocationId:string;
 status:'active'|'paused'|'diverged';
 /** Imported or restored: it never trades until a clean review resumes it. */
 restoreRequired:boolean;
 /** Why it is not following its strategy: imported, restored from a backup, paused by you, stopped at its loss limit, or out of step with the account. */
 pauseReason:'imported'|'restored'|'paused_by_you'|'loss_limit'|'account_changed'|'share_event'|null;
 /** Share-count changes waiting for the member to apply (a reverse split) or dismiss after checking Robinhood. */
 shareEvents:{id:string;symbol:string;effectiveOn:string;kind:'split'|'unclassified';splitTo:number|null;splitFrom:number|null}[];
 reviewedAt:string;
 /** What the allocation claims per holding beside what the account has free for it now. */
 positions:{instrumentRef:string;symbol:string|null;claimed:string;available:string|null}[];
 cash:{claimed:string;available:string|null};
 /** Open differences touching this allocation. */
 cases:{id:string;cause:string;symbol:string|null;claimed:string|null;observed:string|null;difference:string|null;yourShare:string|null;canKeepReduced:boolean;
  /** A negative balance on the take's own books that the member can cover from their account cash (hosted's operator correction). */
  canCover?:boolean;
  /** Shares the take sold beyond what it held; covering cannot settle these. */
  oversold?:{symbol:string|null;quantity:string}[]}[];
 /** Why the review cannot conclude yet: 'fills_pending' (sync still settling fills) or 'evidence_stale' (sync first). */
 blockers:string[];
 ready:boolean;
}

/** A write's answer: the panel reads `ok`, `message` and `code`. */
export type AllocationWriteResult={ok:true;status:number;body:unknown}|{ok:false;status:number;message:string;code:string|null};
export type AllocationSellChoice='none'|'all'|string[];

export interface AllocationsAPI {
 versionReview(id:string):Promise<import('./take-version-review').TakeVersionReview>;
 adoptVersion(id:string,from:string,to:string):Promise<import('./take-version-review').TakeVersionReview>;
 review(allocationId:string):Promise<AllocationReview>;
 resume(allocationId:string):Promise<AllocationReview>;
 pause(allocationId:string):Promise<AllocationReview>;
 keepReduced(allocationId:string,caseId:string):Promise<AllocationReview>;
 /** Records the take's negative cash as money the member put in; nothing is traded. */
 coverShortfall(allocationId:string,caseId:string):Promise<AllocationReview>;
 /** Apply a reverse split, or dismiss a share-count reading, after checking Robinhood. */
 decideShareEvent(allocationId:string,eventId:string,decision:'apply'|'dismiss'):Promise<AllocationReview>;
 // Member instructions, in the shapes the strategy panel reads.
 /** Every allocation on the selected account, as GET /api/strategy-holdings returns it. */
 holdings():Promise<{status:number;holdings:unknown[];selfDirected:unknown[]}>;
 create(input:{strategyId:string;financialAccountId:string;allocationValue:string}):Promise<AllocationWriteResult>;
 update(allocationId:string,input:{status?:'active'|'paused'|'detached'}):Promise<AllocationWriteResult>;
 deposit(allocationId:string,amount:string):Promise<AllocationWriteResult>;
 redemptionPreview(allocationId:string,amount:string):Promise<{status:number;redemption:unknown|null}>;
 redeem(allocationId:string,amount:string):Promise<AllocationWriteResult>;
 instructions(allocationId:string):Promise<{status:number;instructions:unknown[]}>;
 cancelInstruction(allocationId:string,instructionId:string):Promise<AllocationWriteResult>;
 confirmInstruction(allocationId:string,instructionId:string):Promise<AllocationWriteResult>;
 resolveOutsideSale(allocationId:string,resolution:'keep'|'detach'):Promise<AllocationWriteResult>;
 /** The member checked Robinhood: an order of unknown outcome is not there (hosted operator cancel). */
 abandonOrder(allocationId:string,legId:string):Promise<AllocationWriteResult>;
 close(allocationId:string,sell:AllocationSellChoice):Promise<AllocationWriteResult>;
 plan(allocationId:string):Promise<AllocationWriteResult>;
 preflight(target:{strategyId:string}|{bucketId:string},amount:string):Promise<{status:number;preflight:unknown|null}>;
 activity(strategyId:string,limit?:number,cursor?:string|null):Promise<{status:number;events:unknown[];nextCursor:string|null}>;
 queueList():Promise<{ok:true;items:unknown[]}|{ok:false;status:number;message:string}>;
 queueAct(itemId:string,action:'cancel'|'confirm'):Promise<{ok:true;items:unknown[]}|{ok:false;status:number;message:string}>;
 tradingPreferences():Promise<{ok:true;preferences:{confirmTrades:boolean;blockedSymbols:string[]}}|{ok:false;status:number;message:string}>;
 setTradingPreferences(input:{confirmTrades?:boolean;blockedSymbols?:string[]}):Promise<{ok:true;preferences:{confirmTrades:boolean;blockedSymbols:string[]}}|{ok:false;status:number;message:string}>;
}
