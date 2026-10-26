import React from 'react';
import {createRoot} from 'react-dom/client';
import {createMemoryHistory,createRootRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {TakeRules,RuleProposalCards} from '../../../src/renderer/src/strategies/TakeRules';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import '../../../src/renderer/src/theme.css';
// Synthetic Take rules for the Rules window; no host, profile or credentials.
const account='33333333-3333-4333-8333-333333333333';
const notify={...dataSourceThresholdPreset('11111111-1111-4111-8111-111111111111','btc_price','80000',{kind:'notify',message:'BTC crossed the price threshold.'}),name:'BTC price drop'};
const agentAction={kind:'agent',instructions:{format:'prompt',text:'Check whether the move is news-driven. If it is noise and the Take is off target, rebalance.'},
 capabilities:{tools:['opentake_read_rules','opentake_read_strategy'],accountIds:[],actions:['notify']},budget:{}};
const agent={...notify,id:'22222222-2222-4222-8222-222222222222',name:'Check BTC moves',action:agentAction,policy:{...notify.policy,maxRuns:3}};
const weekend={...notify,id:'44444444-4444-4444-8444-444444444444',name:'Weekend drift check',trigger:{...notify.trigger,operator:'crosses_above',value:'90000'}};
const old={...notify,id:'55555555-5555-4555-8555-555555555555',name:'Old 82,500 alert',trigger:{...notify.trigger,value:'82500'}};
const traded={...agent,action:{...agentAction,capabilities:{tools:['opentake_read_rules','opentake_read_strategy','opentake_request_trade'],accountIds:[account],actions:['rebalance_to_target'],maxTradeNotionalUsd:'50'}},policy:{...agent.policy,cooldownMs:7200000}};
const hedge={...agent,id:'66666666-6666-4666-8666-666666666666',name:'Hedge on spikes',trigger:{...notify.trigger,operator:'crosses_above',value:'95000'}};
const inputs={inputs:[{key:'btc_price',feedId:'price:BTC-USD'}],maxSkewMs:5000};
const createdAt=new Date(Date.now()-180000).toISOString();
const proposal={id:'proposal',takeId:'take',messageId:'message',status:'pending',createdAt,before:{schemaVersion:1,rules:[notify,agent,weekend,old]},config:{schemaVersion:1,rules:[notify,traded,weekend,hedge]},inputs,beforeInputs:inputs};
let approvals=[{requestId:'99999999-9999-4999-8999-999999999999',venue:'robinhood',ruleName:'Cash buffer',kind:'reduce',amount:'25',createdAt:new Date().toISOString(),orders:[{side:'sell',symbol:'VTI',amountUsd:'25'}]}];
let accepted=proposal.before,disabled=[weekend.id],revision=1;
const lifecycle=()=>({[notify.id]:{hidden:false,status:'Waiting',runs:1,lastAt:new Date(Date.now()-600000).toISOString()},[agent.id]:{hidden:false,status:'Awaiting approval',reviewId:'review',runs:1,lastAt:new Date(Date.now()-7200000).toISOString()}});
const review=()=>({takeId:'take',revision,version:'v',inputRevision:1,config:accepted,inputs,proposals:proposal.status==='pending'?[proposal]:[],stale:false,execution:'notifications_and_trading',
 disabledRuleIds:disabled,tradingRuleIds:accepted.rules.some(r=>r.id===traded.id&&r.action.capabilities.accountIds.length)?[agent.id]:[],tradingEnabled:true,confirmTrades:false,
 accounts:{[account]:{label:'Opentake',venue:'coinbase'}},lifecycle:lifecycle()});
const activity=[
 {requestId:'a1',at:new Date(Date.now()-7200000).toISOString(),status:'executed',actionKind:'agent',job:{kind:'agent_run',state:'succeeded',reason:'completed',waitingFor:null},runId:'run',fills:[]},
 {requestId:'a2',at:new Date(Date.now()-86400000).toISOString(),status:'action_blocked',actionKind:'agent',job:{kind:'agent_run',state:'blocked',reason:'token_limit_required',waitingFor:null},fills:[]},
];
export const requests:Record<string,unknown>[]=[];
(window as any).takes={automaticLimits:async()=>({durationMs:300000,toolCalls:20,modelTurns:20,costUsd:1,outputTokens:50000})};
(window as any).dataSources={configure:async(request:any)=>{
 requests.push(request);(window as any).fixtureRequests=requests;
 if(request.action==='rule-message-proposals')return [{...proposal}];
 if(request.action==='rule-review')return review();
 if(request.action==='rule-activity')return request.ruleId===agent.id?activity:[];
 if(request.action==='rule-trade-approvals')return approvals;
 if(request.action==='rule-trade-decide'){approvals=approvals.filter(a=>a.requestId!==request.requestId);return undefined;}
 if(request.action==='rule-set-enabled'){disabled=request.enabled?disabled.filter(id=>id!==request.ruleId):[...disabled,request.ruleId];return review();}
 if(request.action==='rule-remove'){accepted={...accepted,rules:accepted.rules.filter(r=>r.id!==request.ruleId)};revision++;proposal.status='superseded';return review();}
 if(request.action==='rule-proposal-decide'){proposal.status=request.decision==='accept'?'accepted':'dismissed';if(request.decision==='accept'){accepted=proposal.config;revision++;}return review();}
 throw Error('Unexpected fixture request');
}};
function Page(){
 return <main className="min-h-screen bg-background text-foreground"><header className="border-b px-8 py-5 text-lg font-medium">Takes · BTC rules walkthrough</header><div className="grid grid-cols-[1fr_390px]"><section className="mx-auto w-full max-w-3xl space-y-6 p-8"><p className="ml-24 rounded-xl bg-muted p-4 text-sm">Let the BTC check rebalance on Coinbase up to $50, add a spike hedge and drop the old alert.</p><p className="text-sm">I proposed the changes.</p><RuleProposalCards messageId="message" running={false}/></section><aside className="min-h-screen border-l px-6 py-8"><h1 className="text-xl font-medium">BTC rules walkthrough</h1><p className="mt-2 mb-5 text-sm text-muted-foreground">Watch BTC and act on significant moves.</p><TakeRules takeId="take" strategyId="strategy" title="BTC rules walkthrough"/></aside></div></main>;
}
const router=createRouter({routeTree:createRootRoute({component:Page}),history:createMemoryHistory({initialEntries:['/']})});
createRoot(document.getElementById('root')!).render(<RouterProvider router={router}/>);
