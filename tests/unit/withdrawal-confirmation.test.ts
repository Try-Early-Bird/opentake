import {test,expect,vi} from 'vitest';
import {confirmWithdrawalReview} from '../../src/renderer/src/strategies/withdrawal-confirmation';
import type {CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const review=(id='old',expiresAt='2020-01-01T00:00:00Z'):CoinbaseOrderReview=>({id,expiresAt,takeId:'take',accountLabel:'Synthetic',takeTitle:'Test',quote:'USDC',phase:'sell',state:'preview',skipped:[],withdrawal:{close:true,requestedAmount:'10',estimatedProceeds:'9.9'},orders:[{product:'BTC-USDC',side:'sell',baseSize:'0.1',limitPrice:'100',notional:'10',fee:'0.1',previewId:id,debits:[{asset:'BTC',quantity:'0.1'}]}]});
const setup=()=>{const next=review('new','2099-01-01T00:00:00Z');return {next,api:{refresh:vi.fn(async()=>next),confirm:vi.fn(async(id:string)=>({...next,id,state:'confirmed' as const})),onRefresh:vi.fn()}};};
test('expired unchanged withdrawal automatically refreshes and confirms only the fresh review',async()=>{
 const {api}=setup();const result=await confirmWithdrawalReview(review(),api);
 expect(result.confirmation?.id).toBe('new');expect(api.confirm).toHaveBeenCalledExactlyOnceWith('new');expect(api.refresh).toHaveBeenCalledTimes(1);
});
test('changed fees, quantities or proceeds refresh the display without confirming',async()=>{
 for(const field of ['fee','baseSize','limitPrice'] as const){const {api,next}=setup();next.orders[0][field]='2';const result=await confirmWithdrawalReview(review(),api);expect(result.confirmation).toBeNull();expect(api.confirm).not.toHaveBeenCalled();expect(api.onRefresh).toHaveBeenCalledWith(next);}
});
test('expiry between click and confirmation refreshes once',async()=>{
 const {api,next}=setup();api.confirm.mockRejectedValueOnce(Error('Review expired. Preview orders again.'));
 const result=await confirmWithdrawalReview({...review(),expiresAt:'2099-01-01T00:00:00Z'},api);
 expect(result.confirmation?.id).toBe(next.id);expect(api.confirm.mock.calls.map(c=>c[0])).toEqual(['old','new']);expect(api.refresh).toHaveBeenCalledTimes(1);
});
test('permission or ambiguous confirmation errors never trigger a refresh or retry',async()=>{
 const {api}=setup();api.confirm.mockRejectedValue(Error('Connection unavailable'));
 await expect(confirmWithdrawalReview(review('old','2099-01-01T00:00:00Z'),api)).rejects.toThrow('Connection unavailable');expect(api.refresh).not.toHaveBeenCalled();expect(api.confirm).toHaveBeenCalledTimes(1);
});
test('fresh confirmation failure after renewal does not loop or hide the error',async()=>{
 const {api}=setup();api.confirm.mockRejectedValue(Error('Review expired. Preview orders again.'));
 await expect(confirmWithdrawalReview(review(),api)).rejects.toThrow('Review expired');expect(api.confirm).toHaveBeenCalledTimes(1);expect(api.refresh).toHaveBeenCalledTimes(1);
});
