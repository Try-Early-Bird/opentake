/** An explicit, feed-local translation into the destination venue's price key. */
export type SourceMarketIdentifier =
  | {kind:'symbol'|'product-id'}
  | {kind:'instrument-id'|'external-id';mappings:{from:string;to:string}[]};
export function marketIdentifierError(venue:'robinhood'|'coinbase', identifier?:SourceMarketIdentifier):string|null {
  if(!identifier)return null; // Existing configurations keep their venue-specific behavior.
  if(identifier.kind==='symbol')return venue==='robinhood'?null:'Stock symbols require a Robinhood destination.';
  if(identifier.kind==='product-id')return venue==='coinbase'?null:'Product IDs require a Coinbase destination.';
  if(identifier.kind==='instrument-id'&&venue!=='robinhood')return 'Instrument IDs require a Robinhood destination.';
  if(!('mappings' in identifier)||!identifier.mappings.length||identifier.mappings.length>200)return 'Add between 1 and 200 ID mappings.';
  const seen=new Set<string>();
  for(const {from,to} of identifier.mappings){
    if(!from||from.length>256||from!==from.trim()||seen.has(from))return 'Incoming IDs must be nonempty and unique.';
    seen.add(from);
    if(identifier.kind==='instrument-id'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(from))return 'Use a Robinhood instrument UUID.';
    if(!(venue==='robinhood'?/^[A-Z][A-Z0-9.-]{0,11}$/:/^[A-Z0-9]+-USD$/).test(to))return venue==='robinhood'?'Choose a stock symbol for every ID.':'Choose a Coinbase USD product ID for every ID.';
  }
  return null;
}
export function resolveSourceMarketIdentifier(value:string, identifier?:SourceMarketIdentifier):string|null {
  if(!identifier||identifier.kind==='symbol'||identifier.kind==='product-id')return value;
  return 'mappings' in identifier?identifier.mappings.find(row=>row.from===value)?.to??null:null;
}
