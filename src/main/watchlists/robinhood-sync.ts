import type {createDatabaseLifecycle} from '../database';
import {marketKey,type MarketHit} from '../../shared/search';
import {watchlistMarket,type WatchlistSyncResult} from '../../shared/watchlists';

// Mirrors the member's Robinhood lists, read-only, in two steps so
// work follows what the member looks at. `syncRobinhoodLists` reads the lists
// themselves (one call); `syncRobinhoodListItems` reads one list's entries,
// only when that list is opened and its entries are stale.
// Robinhood
// is the authority for the entries it reports on a mirrored list (upsert what
// it reports, remove what it stopped reporting); items added in the app, takes
// included, are never touched. A list that disappears upstream is archived,
// not deleted, since the member may re-follow it. A list whose entries cannot
// be read keeps its last known entries. Each step writes with a fixed number
// of set-based statements, however long the list.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
const MAX_DEPTH=12;
export const ROBINHOOD_SYNC_INTERVAL_MS=15*60_000;

export interface RobinhoodWatchlist {id:string;name:string;iconEmoji:string|null;ownerType:'custom'|'curated';allowedObjectTypes:string[]}
export interface RobinhoodWatchlistEntry {objectId:string;objectType:string;symbol:string}

function records(value:unknown,depth=0):Record<string,unknown>[]{
 if(depth>MAX_DEPTH||value===null||typeof value!=='object')return [];
 if(Array.isArray(value))return value.flatMap(item=>records(item,depth+1));
 const record=value as Record<string,unknown>;
 return [record,...Object.values(record).flatMap(item=>records(item,depth+1))];
}
function text(record:Record<string,unknown>,...fields:string[]):string|undefined{
 for(const field of fields){const value=record[field];if(typeof value==='string'&&value.trim())return value.trim();}
 return undefined;
}

/** `get_watchlists`: the member's own and followed lists. */
export function normalizeRobinhoodWatchlists(value:unknown):RobinhoodWatchlist[]{
 const found=new Map<string,RobinhoodWatchlist>();
 for(const record of records(value)){
  const id=text(record,'id','list_id','watchlist_id'),name=text(record,'display_name','name','title');
  // Item rows also carry ids; a list has a name and no object_type.
  if(!id||!name||found.has(id)||text(record,'object_type')!==undefined||id.length>200)continue;
  const owner=text(record,'owner_type','ownerType')?.toLowerCase();
  const icon=text(record,'icon_emoji','icon');
  found.set(id,{id,name:name.slice(0,64),iconEmoji:icon&&icon.length<=16?icon:null,ownerType:owner==='robinhood'||owner==='curated'?'curated':'custom',
   allowedObjectTypes:Array.isArray(record.allowed_object_types)?record.allowed_object_types.filter((t):t is string=>typeof t==='string'):[]});
 }
 return [...found.values()];
}

/** `get_watchlist_items`: membership only (object id, type and symbol), no prices. */
export function normalizeRobinhoodWatchlistEntries(value:unknown):RobinhoodWatchlistEntry[]{
 const found=new Map<string,RobinhoodWatchlistEntry>();
 for(const record of records(value)){
  const objectId=text(record,'object_id','instrument_id','id'),objectType=text(record,'object_type','objectType')?.toLowerCase()??'instrument';
  const symbol=text(record,'symbol','ticker','chain_symbol')?.toUpperCase();
  if(!objectId||!symbol||objectId.length>200||symbol.length>80||!/^[a-z_]{1,80}$/u.test(objectType))continue;
  if(objectType==='instrument'&&!/^[A-Z][A-Z0-9.-]{0,15}$/u.test(symbol))continue;
  const key=`${objectType}:${objectId}`;
  if(!found.has(key))found.set(key,{objectId,objectType,symbol});
 }
 return [...found.values()];
}

/** How a mirrored entry is stored: equities by ticker (the app's key), crypto by pair id, anything else by its object id. */
export function mirroredIdentity(entry:RobinhoodWatchlistEntry):{identity:MarketHit['identity'];key:string;symbol:string}|null{
 if(entry.objectType==='instrument'){
  try{const market=watchlistMarket({identity:{venue:'robinhood',instance:'production',reference:entry.objectId,kind:'equity'},symbol:entry.symbol});return {identity:market.identity,key:market.key,symbol:market.symbol};}
  catch{return null;}
 }
 const identity={venue:'robinhood',instance:'production',reference:entry.objectId,kind:entry.objectType==='currency_pair'?'crypto':entry.objectType};
 return {identity,key:marketKey({identity}),symbol:entry.symbol};
}

export interface RobinhoodListReader {
 /** The connected Robinhood connection's id, or null. */
 connectionId():Promise<string|null>;
 read(name:'get_watchlists'|'get_watchlist_items',args:Record<string,unknown>):Promise<unknown>;
 /** Membership edits on a custom list (write-through); absent when edits stay local. */
 write?(name:'add_to_watchlist'|'remove_from_watchlist',args:Record<string,unknown>):Promise<unknown>;
}

/** The add/remove arguments for one Robinhood market on a list, or null for a kind the tools cannot take. */
export function writeArguments(externalId:string,identity:MarketHit['identity'],symbol:string):Record<string,unknown>|null{
 if(identity.venue!=='robinhood')return null;
 if(identity.kind==='equity')return {list_id:externalId,symbols:[symbol]};
 if(identity.kind==='crypto')return {list_id:externalId,currency_pair_ids:[identity.reference]};
 if(identity.kind==='index')return {list_id:externalId,index_ids:[identity.reference]};
 return null;
}

const OWNER='(SELECT id FROM local_owners LIMIT 1)';
/** Whether the read says entries were left out. */
function claimsMore(value:unknown):boolean{
 return records(value).some(record=>record.has_more===true||record.hasMore===true);
}

/** One list's entries. `get_watchlist_items` takes only `list_id` and returns
 *  the whole list; `complete` is false if a response ever says more follow, so
 *  the caller does not treat an unseen entry as removed upstream. */
export async function readListEntries(reader:Pick<RobinhoodListReader,'read'>,externalId:string):Promise<{entries:RobinhoodWatchlistEntry[];complete:boolean}>{
 const value=await reader.read('get_watchlist_items',{list_id:externalId});
 return {entries:normalizeRobinhoodWatchlistEntries(value),complete:!claimsMore(value)};
}
const stale=(at:Date|null,now:number)=>at===null||now-at.getTime()>=ROBINHOOD_SYNC_INTERVAL_MS;

/** The lists themselves: names, icons and ownership; archives lists gone upstream. */
export async function syncRobinhoodLists(database:Database,reader:RobinhoodListReader,{force,now}:{force:boolean;now:number}):Promise<WatchlistSyncResult>{
 const connectionId=await reader.connectionId();
 if(!connectionId)return {state:'not_connected',syncedAt:null};
 const last=(await database.use(db=>db.query<{at:Date|null}>(`SELECT max(last_synced_at) AS at FROM watchlists WHERE connection_id=$1`,[connectionId]))).rows[0]?.at??null;
 if(!force&&!stale(last,now))return {state:'fresh',syncedAt:last!.toISOString()};
 // Option watchlists hold contracts, not markets, and reject get_watchlist_items.
 const lists=normalizeRobinhoodWatchlists(await reader.read('get_watchlists',{})).filter(l=>!l.allowedObjectTypes.includes('option_strategy'));
 const syncedAt=new Date(now).toISOString();
 const rows=JSON.stringify(lists.map((l,index)=>({external_id:l.id,name:l.name,icon_emoji:l.iconEmoji,owner_type:l.ownerType,ord:index})));
 await database.use(async db=>{
  // New lists follow the member's own, in Robinhood's order.
  await db.query(`INSERT INTO watchlists(owner_id,name,icon_emoji,venue,connection_id,external_id,external_owner_type,position,last_synced_at)
   SELECT ${OWNER},x.name,x.icon_emoji,'robinhood',$1,x.external_id,x.owner_type,coalesce((SELECT max(position)+1 FROM watchlists WHERE owner_id=${OWNER}),0)+x.ord,$3
   FROM jsonb_to_recordset($2::jsonb) AS x(external_id text,name text,icon_emoji text,owner_type text,ord int)
   ON CONFLICT(connection_id,external_id) WHERE external_id IS NOT NULL DO UPDATE SET name=excluded.name,icon_emoji=excluded.icon_emoji,
    external_owner_type=excluded.external_owner_type,last_synced_at=excluded.last_synced_at,archived_at=NULL,updated_at=now()`,[connectionId,rows,syncedAt]);
  await db.query(`UPDATE watchlists SET archived_at=$3,updated_at=now() WHERE connection_id=$1 AND external_id IS NOT NULL AND archived_at IS NULL
   AND NOT (external_id=ANY($2))`,[connectionId,lists.map(l=>l.id),syncedAt]);
 });
 return {state:'synced',syncedAt};
}

/** Whether a mirrored list's entries are due a read from Robinhood. */
export function listItemsStale(itemsSyncedAt:Date|null,now:number):boolean{return stale(itemsSyncedAt,now);}

/** One mirrored list's entries. Unknown or app-only lists are a no-op. */
export async function syncRobinhoodListItems(database:Database,reader:RobinhoodListReader,listId:string,{force,now}:{force:boolean;now:number}):Promise<WatchlistSyncResult>{
 const list=(await database.use(db=>db.query<{external_id:string|null;items_synced_at:Date|null;connection_id:string|null}>(
  `SELECT external_id,items_synced_at,connection_id FROM watchlists WHERE id=$1 AND owner_id=${OWNER} AND archived_at IS NULL AND venue='robinhood'`,[listId]))).rows[0];
 if(!list?.external_id)return {state:'fresh',syncedAt:null};
 if(!force&&!stale(list.items_synced_at,now))return {state:'fresh',syncedAt:list.items_synced_at!.toISOString()};
 if(await reader.connectionId()!==list.connection_id)return {state:'not_connected',syncedAt:null};
 const syncedAt=new Date(now).toISOString();
 let entries:RobinhoodWatchlistEntry[],complete:boolean;
 try{({entries,complete}=await readListEntries(reader,list.external_id));}
 catch(error){
  // A list mid-change can reject the read: keep the last entries and wait out
  // the interval before asking again.
  await database.use(db=>db.query('UPDATE watchlists SET items_synced_at=$2 WHERE id=$1',[listId,syncedAt]));
  throw error;
 }
 // One row per market and per upstream object; the first wins.
 const keys=new Set<string>(),objects=new Set<string>();
 const rows=entries.flatMap((entry,position)=>{
  const market=mirroredIdentity(entry);
  if(!market||keys.has(market.key)||objects.has(entry.objectId))return [];
  keys.add(market.key);objects.add(entry.objectId);
  return [{object_id:entry.objectId,object_type:entry.objectType,market_key:market.key,identity:market.identity,symbol:market.symbol,position}];
 });
 const incoming=JSON.stringify(rows);
 await database.use(db=>db.transaction(async tx=>{
  // Entries gone upstream go first, so a ticker that moved between entries never
  // collides. Only after a complete read: an unseen entry is not a removal.
  if(complete)await tx.query(`DELETE FROM watchlist_items w WHERE w.watchlist_id=$1 AND w.source='mirror'
   AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(object_id text) WHERE x.object_id=w.external_object_id)`,[listId,incoming]);
  // An entry already mirrored whose ticker changed upstream replaces an app copy of the new ticker.
  await tx.query(`DELETE FROM watchlist_items a USING jsonb_to_recordset($2::jsonb) AS x(object_id text,market_key text)
   WHERE a.watchlist_id=$1 AND a.source='app' AND a.market_key=x.market_key
    AND EXISTS (SELECT 1 FROM watchlist_items m WHERE m.watchlist_id=$1 AND m.external_object_id=x.object_id)`,[listId,incoming]);
  // An item the member added in the app becomes the mirrored entry.
  await tx.query(`UPDATE watchlist_items a SET source='mirror',external_object_type=x.object_type,external_object_id=x.object_id
   FROM jsonb_to_recordset($2::jsonb) AS x(object_id text,object_type text,market_key text)
   WHERE a.watchlist_id=$1 AND a.source='app' AND a.market_key=x.market_key`,[listId,incoming]);
  await tx.query(`INSERT INTO watchlist_items(watchlist_id,kind,source,venue,market_key,identity,symbol,external_object_type,external_object_id,position,last_seen_at)
   SELECT $1,'market','mirror','robinhood',x.market_key,x.identity,x.symbol,x.object_type,x.object_id,x.position,$3
   FROM jsonb_to_recordset($2::jsonb) AS x(object_id text,object_type text,market_key text,identity jsonb,symbol text,position int)
   ON CONFLICT(watchlist_id,external_object_id) WHERE external_object_id IS NOT NULL DO UPDATE SET market_key=excluded.market_key,identity=excluded.identity,
    symbol=excluded.symbol,external_object_type=excluded.external_object_type,position=excluded.position,last_seen_at=excluded.last_seen_at`,[listId,incoming,syncedAt]);
  await tx.query('UPDATE watchlists SET items_synced_at=$2,updated_at=now() WHERE id=$1',[listId,syncedAt]);
 }));
 return {state:'synced',syncedAt,...(complete?{}:{partial:true as const})};
}
