import type {RuleLifecycle} from '../../../shared/rule-proposals';

/** One visit per existing approval review; polling and returning to chat must not redirect again. */
export function claimApprovalNavigation(lifecycle:Record<string,RuleLifecycle>|undefined,readOnly:boolean,storage:Pick<Storage,'getItem'|'setItem'>):string|null{
 if(readOnly)return null;
 for(const rule of Object.values(lifecycle??{})){
  if(rule.hidden||rule.status!=='Awaiting approval'||!rule.reviewId)continue;
  const key=`rule-approval-navigation:${rule.reviewId}`;
  if(storage.getItem(key))continue;
  storage.setItem(key,'1');return rule.reviewId;
 }
 return null;
}
