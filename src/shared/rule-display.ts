import type {StrategyRule} from './strategy-rules';
export const duration=(ms:number)=>{if(ms===0)return 'None';const [value,unit]=ms%86400000===0?[ms/86400000,'day']:ms%3600000===0?[ms/3600000,'hour']:ms%60000===0?[ms/60000,'minute']:[ms/1000,'second'];return `${value} ${unit}${value===1?'':'s'}`;};
const decimal=(value:string)=>{const [whole,fraction]=value.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);};
const inputName=(value:string)=>value.replaceAll('_',' ');
export function triggerText(rule:StrategyRule){const t=rule.trigger;return t.kind==='threshold'?`${inputName(t.input)} ${t.operator.replaceAll('_',' ')} ${decimal(t.value)}`:t.kind==='boolean_change'?`${inputName(t.input)} changes to ${t.to}`:`${inputName(t.input)} matches ${JSON.stringify(t.equals)}`;}
export function actionText(rule:StrategyRule){const a=rule.action;return a.kind==='notify'?'Notify me':a.kind==='request_review'?'Request a review':a.kind==='agent'?'Ask the Take agent to assess':a.kind.replaceAll('_',' ');}
/** Every persisted rule property appears in the review, including capability and budget changes. */
export function ruleFields(rule:StrategyRule):Record<string,string>{
 const t=rule.trigger,a=rule.action;
 return {Name:rule.name,Trigger:triggerText(rule),Schedule:'None · source-driven',
 Context:rule.context.length?JSON.stringify(rule.context):'None',
 Conditions:rule.conditions.all.length?JSON.stringify(rule.conditions.all):'None beyond the trigger',
 Action:actionText(rule),'Action details':a.kind==='notify'||a.kind==='request_review'?a.message:JSON.stringify(a),
 Cooldown:duration(rule.policy.cooldownMs),Hold:duration(rule.policy.holdMs),'Maximum runs':String(rule.policy.maxRuns),
 'Decision expiry':rule.action.kind==='rebalance_to_target'?`Automatic action: ${duration(rule.policy.expiresAfterMs)}; manual approval stays open`:duration(rule.policy.expiresAfterMs),Approval:rule.policy.approval==='ask'?'Ask before acting':'Within existing permissions',
 Repeat:t.kind==='threshold'?`Reset ${t.operator.endsWith('below')?'above':'below'} ${decimal(t.resetValue??t.value)} before repeating`:t.kind==='event'?`Once per distinct ${t.eventIdField}`:'After another qualifying change'};
}

export function ruleSentence(rule:StrategyRule,inputs?:import('./take-inputs').TakeInputsConfig){
 const binding=inputs?.inputs.find(input=>input.key===rule.trigger.input);
 const product=binding?.feedId.match(/^price:([A-Z0-9]+)-USD$/)?.[1];
 const trigger=triggerText(rule).replace(inputName(rule.trigger.input),product??inputName(rule.trigger.input));
 const action=rule.action.kind==='notify'?'notify me':rule.action.kind==='request_review'?'ask me to review this Take':rule.action.kind==='agent'?'ask the Take agent to assess':rule.action.kind==='rebalance_to_target'?'rebalance this Take toward its target allocation':actionText(rule);
 return `When ${trigger}, ${action}.`;
}
