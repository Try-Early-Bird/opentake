import {z} from 'zod';
import {ruleDraftConfig,type RuleDraftConfig} from './strategy-rules';
import {takeInputsConfigSchema,type TakeInputsConfig} from './take-inputs';
export const ruleProposalInput=z.object({operationId:z.uuid(),expectedRevision:z.number().int().nonnegative(),expectedVersion:z.uuid(),expectedInputRevision:z.number().int().nonnegative(),config:ruleDraftConfig,inputs:takeInputsConfigSchema}).strict();
export type RuleProposalInput=z.infer<typeof ruleProposalInput>;
/** An agent run's trade request: a rebalance, deploy cash or reduce. Buy, trim
 *  and exit change the Take's target, so an agent proposes them as a Take change instead. */
const requestAmount=z.object({value:z.string().regex(/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/).refine(v=>Number(v)>0),currency:z.enum(['USD','USDC'])}).strict();
export const ruleTradeRequestInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('rebalance_to_target'),accountId:z.uuid(),reason:z.string().trim().min(1).max(1000)}).strict(),
 z.object({kind:z.enum(['deploy_cash','reduce']),accountId:z.uuid(),amount:requestAmount,reason:z.string().trim().min(1).max(1000)}).strict(),
]);
/** An automatic run's conclusion. App-observed outcomes (proposals, trades) are recorded separately. */
export const ruleAssessmentVerdicts=['no_action','watch','needs_you'] as const;
export const ruleAssessmentInput=z.object({verdict:z.enum(ruleAssessmentVerdicts),summary:z.string().trim().min(1).max(280),evidence:z.array(z.string().trim().min(1).max(200)).max(8).default([])}).strict();
export type RuleAssessment=z.output<typeof ruleAssessmentInput>;
export interface RuleProposal {/** Set when an automatic rule run proposed it. */ruleName?:string|null;id:string;takeId:string;messageId:string;status:'pending'|'accepted'|'dismissed'|'superseded';baseRevision:number;baseVersion:string;baseInputRevision:number;config:RuleDraftConfig;inputs:TakeInputsConfig;before:RuleDraftConfig;beforeInputs:TakeInputsConfig;createdAt:string}
export interface RuleLifecycle {reviewId?:string;hidden:boolean;runs?:number;lastAt?:string;status:'Waiting'|'Awaiting approval'|'In progress'|'Needs attention'|'Finished'}
export interface RuleReview {lifecycle?:Record<string,RuleLifecycle>;tradingEnabled?:boolean;tradingRuleIds?:string[];disabledRuleIds?:string[];/** The committed Take's own rebalancing, for what keeps a target change. */rebalancing?:{schedule:string;drift:boolean}|null;accounts?:Record<string,{label:string;venue:string}>;confirmTrades?:boolean;takeId:string;revision:number;version:string;inputRevision:number;config:RuleDraftConfig;inputs:TakeInputsConfig;proposals:RuleProposal[];stale:boolean;execution:'preview_only'|'notifications_only'|'trading_only'|'notifications_and_trading'}
/** One rule firing and what came of it, for the Rules window's Activity. */
export interface RuleActivityItem {requestId:string;at:string;status:string;actionKind:string;job?:{kind:string;state:string;reason:string|null;waitingFor:string|null};trade?:{state:string;reason:string|null};runId?:string;fills:{side:string;product:string;quantity:string}[]}
/** A rule or agent trade waiting for the member's approval, on any venue. */
export interface RuleTradeApproval {requestId:string;venue:string;ruleName:string|null;kind:string;amount:string|null;createdAt:string;orders:{side:'buy'|'sell';symbol:string;amountUsd:string|null}[];/** The orders are sized again when placed. */estimated?:boolean}
export const ruleReviewRequest=z.discriminatedUnion('action',[
 z.object({action:z.literal('rule-review'),takeId:z.uuid()}).strict(),
 z.object({action:z.literal('rule-message-proposals'),messageId:z.uuid()}).strict(),
 z.object({action:z.literal('rule-proposal-decide'),id:z.uuid(),decision:z.enum(['accept','dismiss'])}).strict(),
 z.object({action:z.literal('rule-set-enabled'),takeId:z.uuid(),ruleId:z.uuid(),enabled:z.boolean()}).strict(),
 z.object({action:z.literal('rule-remove'),takeId:z.uuid(),ruleId:z.uuid()}).strict(),
 z.object({action:z.literal('rule-activity'),takeId:z.uuid(),ruleId:z.uuid()}).strict(),
 z.object({action:z.literal('rule-trade-approvals'),takeId:z.uuid()}).strict(),
 z.object({action:z.literal('rule-trade-decide'),takeId:z.uuid(),requestId:z.uuid(),approve:z.boolean()}).strict(),
]);
export type RuleReviewRequest=z.infer<typeof ruleReviewRequest>;

/** Safe, actionable domain messages; never use for provider/database error text. */
export class RuleProposalError extends Error {}

export const ruleActivityInput=z.object({requestId:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(10),before:z.object({createdAt:z.iso.datetime(),id:z.uuid()}).strict().optional()}).strict();
