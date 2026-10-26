import type {OrderStatus} from './trading';
export interface InstructionOrder {symbol:string;side:'buy'|'sell';execution:OrderStatus;filledQuantity?:string;orderType?:'market'|'limit';quantity?:string;estimatedValue?:string;estimatedPrice?:string;estimatedFee?:string;currency?:string}
