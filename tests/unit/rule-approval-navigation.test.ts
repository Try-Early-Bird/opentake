import {expect,test} from 'vitest';
import {claimApprovalNavigation} from '../../src/renderer/src/strategies/rule-approval-navigation';
import type {RuleLifecycle} from '../../src/shared/rule-proposals';
const storage=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};
test('navigates once for each existing approval, including one already waiting on mount',()=>{
 const store=storage();const ready:RuleLifecycle={hidden:false,status:'Awaiting approval',reviewId:'review-1'};
 expect(claimApprovalNavigation({rule:ready},false,store)).toBe('review-1');
 expect(claimApprovalNavigation({rule:ready},false,store)).toBeNull();
 expect(claimApprovalNavigation({rule:{...ready,reviewId:'review-2'}},false,store)).toBe('review-2');
});
test('never navigates without a review, for read-only Takes, or for non-approval states',()=>{
 const store=storage();const ready:RuleLifecycle={hidden:false,status:'Awaiting approval',reviewId:'review'};
 expect(claimApprovalNavigation({rule:ready},true,store)).toBeNull();
 expect(claimApprovalNavigation({rule:{...ready,reviewId:undefined}},false,store)).toBeNull();
 expect(claimApprovalNavigation({rule:{...ready,hidden:true}},false,store)).toBeNull();
 for(const status of ['Waiting','In progress','Needs attention','Finished'] as const)expect(claimApprovalNavigation({rule:{...ready,status}},false,store)).toBeNull();
 expect(claimApprovalNavigation({rule:ready},false,store)).toBe('review');
});
