export type CryptoReviewStage='account'|'provider'|'save'|'display';
export class CryptoReviewFailure extends Error {
 constructor(readonly stage:CryptoReviewStage,readonly failure:unknown){super('Crypto review failed');}
}
export async function cryptoReviewStep<T>(stage:CryptoReviewStage,work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){throw new CryptoReviewFailure(stage,error);}
}
