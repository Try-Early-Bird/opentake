/** A queued investment is still responsible for filling missing holdings. */
export function hasPendingInvestment(instructions:readonly {status:string}[]):boolean{
 return instructions.some(i=>i.status==='pending'||i.status==='open');
}
/** Mixed funding is a local reservation, not an order failure. */
export function pendingInvestmentReason(reason:string|null,marketClosed:boolean):string|null{
 return reason==='mixed_funded'?(marketClosed?'market_closed':'requested'):reason;
}
