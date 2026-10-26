import type {VenueRegistry} from '../venues/registry';
import type {ActionKind,AssetClass} from '../venues/types';

// Can this account do this action, and if not, why. Answered
// from the venue profile, the registered adapters and the account, never from a
// per-venue branch. Used before accepting a rule, when a rule fires, and by chat.

export type UnsupportedReason=
 |'trading_disabled'|'venue_unsupported'|'action_unsupported'|'asset_unsupported'
 |'account_unavailable'|'read_only_key'|'take_required';
export type Capability={supported:true}|{supported:false;reason:UnsupportedReason};
/** Actions that place orders; they need an account that can trade. */
export const tradingActions:readonly ActionKind[]=['rebalance_to_target','buy','trim','exit','deploy_cash','reduce'];
export interface CapabilityRequest{
 kind:ActionKind;
 venue:string|null;
 account:{available:boolean;canTrade:boolean}|null;
 /** Asset classes the action touches, when known. */
 assetClasses?:readonly AssetClass[];
 takeId?:string|null;
 tradingEnabled:boolean;
}

export function actionCapability(registry:VenueRegistry,request:CapabilityRequest):Capability{
 const no=(reason:UnsupportedReason):Capability=>({supported:false,reason});
 if(!tradingActions.includes(request.kind)){
  // Agent runs and Take changes run locally; their own permissions apply later.
  return request.takeId===null?no('take_required'):{supported:true};
 }
 if(!request.tradingEnabled)return no('trading_disabled');
 if(!request.venue||!registry.has(request.venue))return no('venue_unsupported');
 const profile=registry.profile(request.venue);
 if(!registry.adapter(request.venue,request.kind))return no('action_unsupported');
 if(request.assetClasses?.some(c=>!profile.assetClasses.includes(c)))return no('asset_unsupported');
 if(!request.account?.available)return no('account_unavailable');
 if(!request.account.canTrade)return no('read_only_key');
 return {supported:true};
}
