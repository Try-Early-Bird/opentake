import type {createDatabaseLifecycle} from '../database';
import type {VenueRegistry} from '../venues/registry';
import type {ActionJob} from '../venues/types';
import {actionCapability,tradingActions} from './capabilities';

// Whether a trade job may start, answered the same way for every venue: the
// firing is still active, its rule is still accepted, granted and on, trading is
// on, and the venue can do the action. Read from the database each time, never
// from a saved result. The checks and reasons are the structural half of the
// Robinhood rule-trade guard, which both engines keep until they opt in to the
// core's admission (`VenueModule.admission='core'`).

export type AdmissionRefusal=
 |'trading_disabled'|'request_inactive'|'request_expired'|'take_version_changed'
 |'trading_not_granted'|'rule_off'|'venue_unsupported'|'action_unsupported'
 |'asset_unsupported'|'account_unavailable'|'read_only_key'|'take_required';
export type Admission={admitted:true}|{admitted:false;reason:AdmissionRefusal};
/** `started`: the adapter has already run, so an expired request no longer refuses
 *  (an approval, once asked for, stays open until decided). */
export type AdmissionCheck=(job:ActionJob,started:boolean)=>Promise<Admission>;

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export function ruleTradeAdmission(database:Database,registry:VenueRegistry,tradingEnabled:()=>boolean):AdmissionCheck{
 return async(job,started)=>{
  const no=(reason:AdmissionRefusal):Admission=>({admitted:false,reason});
  // Agent runs and Take changes carry their own permissions.
  if(!tradingActions.includes(job.kind))return {admitted:true};
  if(!tradingEnabled())return no('trading_disabled');
  const account=job.accountId?(await database.use(db=>db.query<{available:boolean}>('SELECT available FROM linked_accounts WHERE id=$1',[job.accountId]))).rows[0]:undefined;
  // Whether the key can trade stays with each venue's engine until the venue reports it.
  const capability=actionCapability(registry,{kind:job.kind,venue:job.venue,takeId:job.takeId,tradingEnabled:true,account:account?{available:account.available,canTrade:true}:null});
  if(!capability.supported)return no(capability.reason);
  // Member-origin actions have no firing to check.
  if(job.origin==='member')return {admitted:true};
  const row=(await database.use(db=>db.query<{status:string;expired:boolean;current:boolean;granted:boolean;disabled:boolean}>(`
   SELECT r.status,r.expires_at<=$2 AS expired,
    (a.trading_enabled AND r.rule_id=ANY(a.trading_rule_ids)) AS granted,r.rule_id=ANY(a.disabled_rule_ids) AS disabled,
    d.accepted_version IS NOT DISTINCT FROM (SELECT current_version_id FROM strategies WHERE id=t.strategy_id) AS current
   FROM strategy_rule_action_requests r JOIN takes t ON t.id=r.take_id AND t.archived_at IS NULL
   JOIN strategy_rule_accepted a ON a.take_id=r.take_id AND a.revision=r.draft_revision
   JOIN strategy_rule_shadow sh ON sh.take_id=r.take_id AND sh.enabled AND sh.draft_revision=a.revision
   JOIN strategy_rule_draft_revisions d ON d.take_id=a.take_id AND d.revision=a.revision WHERE r.id=$1`,[job.originId,new Date()]))).rows[0];
  if(!row||row.status!=='shadow')return no('request_inactive');
  if(row.expired&&!started)return no('request_expired');
  if(!row.current)return no('take_version_changed');
  if(!row.granted)return no('trading_not_granted');
  if(row.disabled)return no('rule_off');
  return {admitted:true};
 };
}
