import {investmentVenues} from '../../shared/investment-venues';
import {tradingSessionPolicy} from '../trading/session-policy';
import type {ActionAdapter,ActionKind,AssetClass,VenueModule,VenueProfile} from './types';

// One entry per venue. Adding a platform means registering one
// module here (and a `venues` row in an appended migration), not editing the core.

const session=(venue:string)=>(assetClass:AssetClass)=>tradingSessionPolicy(venue,assetClass);

/** Coinbase spot crypto: continuous calendar, fractional and notional orders. */
export const coinbaseProfile:VenueProfile=Object.freeze<VenueProfile>({
 id:'coinbase',label:investmentVenues.coinbase.label,
 assetClasses:['crypto'],orderTypes:['market','limit'],fractional:['crypto'],notional:['crypto'],
 quoteCurrencies:investmentVenues.coinbase.currencies,session:session('coinbase'),
 limits:{callTimeoutMs:60_000,schedulerIntervalMs:15_000},
});
/** Robinhood equities and ETFs on the regular session; crypto reads only for now. */
export const robinhoodProfile:VenueProfile=Object.freeze<VenueProfile>({
 id:'robinhood',label:investmentVenues.robinhood.label,
 assetClasses:['equity','etf'],orderTypes:['market','limit'],fractional:['equity','etf'],notional:['equity','etf'],
 quoteCurrencies:investmentVenues.robinhood.currencies,session:session('robinhood'),
 limits:{callTimeoutMs:60_000,schedulerIntervalMs:30_000},
});

/** `local`: actions that run in the app rather than on a venue (agent runs, Take changes). */
export function createVenueRegistry(modules:readonly VenueModule[],local:Partial<Record<ActionKind,ActionAdapter<any,any>>>={}){
 const byId=new Map<string,VenueModule>();
 for(const [kind,adapter] of Object.entries(local))if(adapter&&adapter.kind!==kind)throw new Error(`Adapter for ${kind} declares ${adapter.kind}`);
 for(const module of modules){
  if(!/^[a-z][a-z0-9_]{1,31}$/.test(module.profile.id))throw new Error(`Invalid venue id ${module.profile.id}`);
  if(byId.has(module.profile.id))throw new Error(`Venue ${module.profile.id} registered twice`);
  for(const [kind,adapter] of Object.entries(module.adapters))if(adapter&&adapter.kind!==kind)throw new Error(`Adapter for ${kind} declares ${adapter.kind}`);
  byId.set(module.profile.id,module);
 }
 return {
  list:()=>[...byId.values()].map(m=>m.profile),
  has:(venue:string)=>byId.has(venue),
  profile(venue:string):VenueProfile{const m=byId.get(venue);if(!m)throw new Error(`Unknown venue ${venue}`);return m.profile;},
  adapter(venue:string,kind:ActionKind):ActionAdapter|undefined{return byId.get(venue)?.adapters[kind];},
  module:(venue:string)=>byId.get(venue),
  local:(kind:ActionKind):ActionAdapter|undefined=>local[kind],
 };
}
export type VenueRegistry=ReturnType<typeof createVenueRegistry>;
