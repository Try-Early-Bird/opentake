import type { CustomSourceConfig } from './data-sources';
export interface WsPredicate { path:string[];equals:string|number|boolean|null }
export interface WsAcknowledgement {success:WsPredicate;failure:WsPredicate}
export interface WsTemplate {body:Record<string,unknown>;secretPaths?:string[][]}
export interface WebsocketConnection {
 endpoint:string;dataMode?:'json'|'text';
 auth:{mode:'none'}|{mode:'header'|'subscription';credentialId:string}|{mode:'login';credentialId:string;message:WsTemplate;acknowledgement:WsAcknowledgement};
 subscription:WsTemplate;acknowledgement:WsAcknowledgement;
}
export interface WebsocketSourceConfig {
 provider?:{kind:'coinbase-market';priceMappings?:import('./coinbase-field-mappings').CoinbasePriceMappings;subscriptions:import('./coinbase-source').CoinbaseSubscriptions};
 transport:'websocket';name:string;collection:'automatic'|'when-open'|'off';freshnessMs:number;connection:WebsocketConnection;
 feeds:Array<Omit<CustomSourceConfig['feeds'][number],'mapping'> & {mapping:CustomSourceConfig['feeds'][number]['mapping']|{kind:'text'}}>;
}
export interface WebsocketSource {id:string;revision:number;enabled:boolean;validated:boolean;config:WebsocketSourceConfig}
export interface WebsocketMessage {id:number;receivedAt:number;type:'json'|'text'|'open'|'close'|'notice';text:string;bytes:number}
export interface WebsocketMessages {messages:WebsocketMessage[];cursor:number;total:number;startedAt:number|null}
export type WebsocketRequest = {action:'websocket-list'}|{action:'websocket-inspect';connection:WebsocketConnection}|{action:'websocket-messages';id:string;revision:number;after?:number}|{action:'websocket-policy';id:string;revision:number;collection?:'automatic'|'when-open';storage?:'live'|'latest'|'history';sampleEveryMs?:number;retentionDays?:1|7|30|90};
