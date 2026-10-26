import {z} from 'zod';
const path=z.array(z.string().min(1).max(80).refine(key=>!['__proto__','prototype','constructor'].includes(key))).min(1).max(8);
export const defaultCoinbasePriceMappings={product:['product_id'],price:['price'],time:['time']};
export const coinbasePriceMappingSchema=z.object({product:path,price:path,time:path}).strict();
export type CoinbasePriceMappings=z.infer<typeof coinbasePriceMappingSchema>;
/** Only own data properties; never evaluate expressions or traverse prototypes. */
export function readMappedField(value:unknown,path:readonly string[]):unknown{
 for(const key of path){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key];}return value;
}
export const coinbaseAccountConfigSchema=z.object({
 reads:z.object({portfolio:z.boolean(),positionDetails:z.boolean(),orders:z.boolean(),fills:z.boolean(),history:z.boolean()}).strict(),
}).strict().refine(config=>config.reads.portfolio||(!config.reads.positionDetails&&!config.reads.history),'Position details and history require balances and holdings');
export type CoinbaseAccountSourceConfig=z.infer<typeof coinbaseAccountConfigSchema>;
/** `unreadable`: the saved row no longer matches the schema, so `config` is the defaults until the member saves. */
export interface CoinbaseAccountSourceSetting {accountId:string;revision:number;config:CoinbaseAccountSourceConfig;unreadable?:true}
export const defaultCoinbaseAccountConfig:CoinbaseAccountSourceConfig={reads:{portfolio:true,positionDetails:true,orders:true,fills:true,history:true}};
/** A stored account config, or the defaults when it cannot be read; never throws. */
export function readCoinbaseAccountConfig(stored:unknown):{config:CoinbaseAccountSourceConfig;unreadable:boolean}{
 const parsed=coinbaseAccountConfigSchema.safeParse(stored);
 return parsed.success?{config:parsed.data,unreadable:false}:{config:defaultCoinbaseAccountConfig,unreadable:true};
}
