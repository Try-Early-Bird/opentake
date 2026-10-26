/** Retain only known operation/category identifiers, never provider text or args. */
const operations={session:'opening the Robinhood session',get_accounts:'account lookup',get_currency_pairs:'crypto market lookup',preview_crypto_order:'crypto order preview',get_crypto_orders:'crypto order status',get_trade_approvals:'trade approval status',get_crypto_positions:'crypto holdings lookup'} as const;
const categories={invalid_response:'Robinhood returned unreadable response data.',invalid_params:'The MCP request or response failed schema validation (code -32602).',invalid_rpc:'Robinhood rejected the MCP operation (code -32600).',missing_tool:'Robinhood did not recognize the requested tool (code -32601).',rpc_error:'Robinhood returned an MCP server error.',network_error:'The network connection failed.',timed_out:'The request timed out.',cancelled:'The request was cancelled.',invalid_request:'Robinhood rejected the request parameters.',rate_limited:'Robinhood reported a rate limit.',unauthorized:'Robinhood requires authorization.',forbidden:'Robinhood refused access.',internal_error:'Robinhood reported an internal error.'} as const;
export class RobinhoodReadFailure extends Error {
 readonly operation:keyof typeof operations|null;
 readonly category:keyof typeof categories|null;
 constructor(operation:string,category:unknown){
  super('Robinhood read failed');
  this.operation=Object.hasOwn(operations,operation)?operation as keyof typeof operations:null;
  this.category=typeof category==='string'&&Object.hasOwn(categories,category)?category as keyof typeof categories:null;
 }
 publicMessage(){return `Robinhood failed at ${this.operation?operations[this.operation]:'data lookup'}. ${this.category?categories[this.category]:'Robinhood did not supply a recognized error category.'}`;}
}

/** Classify SDK failures before any result exists; do not retain messages/cause bodies. */
export function readFailureCategory(error:unknown):string|null {
 const value=error as {code?:unknown;cause?:{code?:unknown};name?:unknown}|null;
 const code=value?.cause?.code??value?.code;
 if(code===-32602)return 'invalid_params';
 if(code===-32600)return 'invalid_rpc';
 if(code===-32601)return 'missing_tool';
 if(code===-32001||value?.name==='TimeoutError')return 'timed_out';
 if(typeof code==='number'&&code>=-32099&&code<=-32000)return 'rpc_error';
 if(code===401)return 'unauthorized';if(code===403)return 'forbidden';if(code===429)return 'rate_limited';
 if(value?.name==='AbortError')return 'cancelled';
 if(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT'].includes(String(code)))return 'network_error';
 return null;
}
