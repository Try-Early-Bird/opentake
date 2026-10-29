import {z} from 'zod';
import {marketIdentitySchema} from './search';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value));
// Decimal strings preserve threshold and sizing precision; no floating-point coercion.
export const ruleDecimal=z.string().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,36})?$/);
const positive=z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/).refine(value=>/[1-9]/.test(value));
const unique=<T>(items:T[])=>new Set(items).size===items.length;
export const ruleComparison=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('numeric'),input:key,operator:z.enum(['lt','lte','gt','gte','eq']),value:ruleDecimal}).strict(),
 z.object({kind:z.literal('boolean'),input:key,value:z.boolean()}).strict(),
]);
export const ruleTrigger=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('threshold'),input:key,operator:z.enum(['above','below','crosses_above','crosses_below']),value:ruleDecimal,resetValue:ruleDecimal.optional()}).strict(),
 z.object({kind:z.literal('boolean_change'),input:key,to:z.boolean()}).strict(),
 // The ID must be an explicit source field: repeated deliveries of the same event do not create new runs.
 z.object({kind:z.literal('event'),input:key,eventIdField:z.string().min(1).max(128).refine(value=>!['constructor','prototype','__proto__'].includes(value)),equals:z.union([z.string().max(2048),z.number().finite(),z.boolean()])}).strict(),
]);
const scope=z.object({accountId:z.uuid()}).strict();
const amount=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('notional'),value:positive,currency:z.enum(['USD','USDC'])}).strict(),
 z.object({kind:z.literal('quantity'),value:positive}).strict(),
 z.object({kind:z.literal('scope_bps'),value:z.number().int().min(1).max(10000)}).strict(),
]);
const allowedAction=z.enum(['notify','request_review','pause_self','buy','trim','exit','rebalance_to_target','deploy_cash','reduce']);
export const ruleAction=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('notify'),message:z.string().trim().min(1).max(2000)}).strict(),
 z.object({kind:z.literal('request_review'),message:z.string().trim().min(1).max(2000)}).strict(),
 z.object({kind:z.literal('pause_self')}).strict(),
 z.object({kind:z.literal('buy'),scope,market:marketIdentitySchema,amount}).strict(),
 z.object({kind:z.literal('trim'),scope,market:marketIdentitySchema,toWeightBps:z.number().int().min(0).max(10000)}).strict(),
 z.object({kind:z.literal('exit'),scope,market:marketIdentitySchema.optional()}).strict(),
 z.object({kind:z.literal('rebalance_to_target'),scope}).strict(),
 z.object({kind:z.literal('deploy_cash'),scope,amount:z.object({value:positive,currency:z.enum(['USD','USDC'])}).strict()}).strict(),
 // Sell across the Take's holdings to raise an amount; the proceeds return to the account.
 z.object({kind:z.literal('reduce'),scope,amount:z.object({value:positive,currency:z.enum(['USD','USDC'])}).strict()}).strict(),
 z.object({kind:z.literal('agent'),instructions:z.object({format:z.enum(['prompt','rules.md','prompt.md']),text:z.string().trim().min(1).max(16000)}).strict(),
  // These are ceilings requested by the draft, never grants of permission.
  capabilities:z.object({tools:z.array(z.string().min(1).max(160)).max(64).refine(unique),accountIds:z.array(z.uuid()).max(16).refine(unique),actions:z.array(allowedAction).min(1).max(8).refine(unique),maxTradeNotionalUsd:positive.optional()}).strict(),
  // Each limit is optional: a run uses the lower of the rule's value and AI settings ›
  // Automatic runs, which is also the default. maxOutputTokens gates Codex and Grok.
  budget:z.object({maxDurationMs:z.number().int().min(1000).max(3600000).optional(),maxToolCalls:z.number().int().min(1).max(500).optional(),maxTurns:z.number().int().min(1).max(200).optional(),maxCostUsd:positive.optional(),maxOutputTokens:z.number().int().min(1).max(10_000_000).optional()}).strict().default({}),
 }).strict(),
]);
export const rulePolicy=z.object({cooldownMs:z.number().int().min(0).max(365*86400000),holdMs:z.number().int().min(0).max(86400000),maxRuns:z.number().int().min(1).max(100000),expiresAfterMs:z.number().int().min(1000).max(86400000),approval:z.enum(['ask','within_existing_policy'])}).strict();
function decimalParts(value:string){const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');return (negative?-1n:1n)*BigInt(whole+fraction.padEnd(36,'0'));}
export const ruleWindowStep=z.object({kind:z.literal('window'),output:key,input:key,operation:z.enum(['sum','mean','min','max']),windowMs:z.number().int().min(2000).max(300000),minSamples:z.number().int().min(2).max(512),maxGapMs:z.number().int().min(1000).max(60000)}).strict();
export const ruleContextStep=z.discriminatedUnion('kind',[
 ruleWindowStep,
 z.object({kind:z.literal('fetch'),output:key,input:key,freshness:z.enum(['latest','next']),timeoutMs:z.number().int().min(100).max(5000)}).strict(),
 z.object({kind:z.literal('derive'),output:key,operation:z.enum(['sum','mean','min','max','difference']),inputs:z.array(key).min(1).max(8)}).strict(),
]);
export const strategyRule=z.object({id:z.uuid(),name:z.string().trim().min(1).max(120),trigger:ruleTrigger,context:z.array(ruleContextStep).max(8).default([]),conditions:z.object({all:z.array(ruleComparison).max(16)}).strict(),action:ruleAction,policy:rulePolicy}).strict().superRefine((rule,ctx)=>{
 const trigger=rule.trigger;
 const available=new Set([trigger.input]);
 for(const [index,step] of rule.context.entries()){
  if(available.has(step.output))ctx.addIssue({code:'custom',path:['context',index,'output'],message:'Context outputs must be unique and cannot replace the trigger input.'});
  if(step.kind==='window'&&step.maxGapMs>step.windowMs)ctx.addIssue({code:'custom',path:['context',index,'maxGapMs'],message:'Window gap must not exceed its duration.'});
  if(step.kind==='derive'){
   if(step.inputs.some(input=>!available.has(input)))ctx.addIssue({code:'custom',path:['context',index,'inputs'],message:'Derived inputs must reference the trigger or earlier step outputs.'});
   if(step.operation==='difference'&&step.inputs.length!==2)ctx.addIssue({code:'custom',path:['context',index,'inputs'],message:'Difference requires exactly two inputs.'});
  }
  available.add(step.output);
 }
 if(rule.context.length&&rule.conditions.all.some(condition=>!available.has(condition.input)))ctx.addIssue({code:'custom',path:['conditions'],message:'Context conditions must reference the trigger or a context output.'});

 if(trigger.kind==='threshold'&&trigger.resetValue!==undefined&&ruleDecimal.safeParse(trigger.value).success&&ruleDecimal.safeParse(trigger.resetValue).success){
  const reset=decimalParts(trigger.resetValue),threshold=decimalParts(trigger.value),above=trigger.operator.endsWith('above');
  if(above?reset>=threshold:reset<=threshold)ctx.addIssue({code:'custom',path:['trigger','resetValue'],message:'Reset must be below an above threshold or above a below threshold.'});
 }
 if(rule.action.kind==='agent'){
  const capabilities=rule.action.capabilities;
  const trading=capabilities.actions.some(action=>['buy','trim','exit','rebalance_to_target','deploy_cash','reduce'].includes(action));
  if(trading&&(!capabilities.accountIds.length||!capabilities.maxTradeNotionalUsd))ctx.addIssue({code:'custom',path:['action','capabilities'],message:'Agent trading requires explicit accounts and a notional ceiling.'});
 }
 if(trigger.kind==='event'&&rule.policy.holdMs!==0)ctx.addIssue({code:'custom',path:['policy','holdMs'],message:'Events cannot use a continuous hold window.'});
});
export const ruleDraftConfig=z.object({schemaVersion:z.literal(1),rules:z.array(strategyRule).max(16).refine(items=>unique(items.map(item=>item.id)))}).strict().refine(config=>new TextEncoder().encode(JSON.stringify(config)).length<=64000,'Rule drafts exceed 64,000 bytes');
export type StrategyRule=z.infer<typeof strategyRule>;
export type RuleDraftConfig=z.infer<typeof ruleDraftConfig>;
export const ruleDraftSave=z.object({takeId:z.uuid(),revision:z.number().int().nonnegative(),acceptedVersion:z.uuid(),inputRevision:z.number().int().nonnegative(),config:ruleDraftConfig}).strict();
export type RuleDraftSetting=z.infer<typeof ruleDraftSave>;
export type RuleDraftRequest={action:'rule-drafts-load'|'rule-drafts-preview';takeId:string}|{action:'rule-drafts-save';setting:RuleDraftSetting};
/** A preset is configuration using the same contract, not a separate execution path. */
export function dataSourceThresholdPreset(id:string,input:string,value:string,action:StrategyRule['action']):StrategyRule{
 return strategyRule.parse({id,name:'Data-source threshold',trigger:{kind:'threshold',input,operator:'crosses_below',value},conditions:{all:[]},action,
  policy:{cooldownMs:3600000,holdMs:0,maxRuns:1,expiresAfterMs:300000,approval:'ask'}});
}

export type RuleShadowRequest={action:'rule-shadow-status';takeId:string}|{action:'rule-shadow-configure';setting:{takeId:string;draftRevision:number;enabled:boolean;delivery?:'shadow'|'notifications'}};

export const ruleEvidenceRequest=z.discriminatedUnion('action',[
 z.object({action:z.literal('rule-evidence-list'),takeId:z.uuid(),limit:z.number().int().min(1).max(50).default(20),before:z.object({createdAt:z.iso.datetime(),id:z.uuid()}).strict().optional()}).strict(),
 z.object({action:z.literal('rule-evidence-read'),takeId:z.uuid(),requestId:z.uuid()}).strict(),
]);
export type RuleEvidenceRequest=z.input<typeof ruleEvidenceRequest>;

/** First live trading adapter; other action shapes remain previews. */
/** Rule trades the venues execute: rebalance, deploy cash and reduce. */
export const ruleTradeKinds=['rebalance_to_target','deploy_cash','reduce'] as const;
export const supportsRuleTrade=(rule:StrategyRule)=>(ruleTradeKinds as readonly string[]).includes(rule.action.kind)&&rule.trigger.kind==='threshold'&&!rule.context.length;
