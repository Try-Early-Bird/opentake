import type {DatabaseClient} from '../database-client';
import type {DataFeedRef,DataObservation,DataSnapshot} from '../../shared/data-sources';
export interface RuleEventSubscription {ruleId:string;revision:number;ref:DataFeedRef}
export interface RuleEventBatch {durable?:boolean;record?(observation:DataObservation,reason:string):void;commit?(tx:Pick<DatabaseClient,'query'>):Promise<void>;gap:boolean;observations:DataObservation[];snapshot:DataSnapshot;valid():boolean;ack():boolean}
export interface RuleEvents {sync(takeId:string,subscriptions:RuleEventSubscription[]):void;read(takeId:string,ruleId:string):RuleEventBatch|null|Promise<RuleEventBatch|null>}
