/** Chat's request to turn on a tool, decided by the member from the reply that made it. */
export interface ToolAccessRequest {id:string;messageId:string;serverId:string;server:string;toolName:string;policy:'ask'|'allowed';reason:string;status:'pending'|'approved'|'declined'|'superseded';createdAt:string}
export interface PlatformAccessRequest {id:string;run_id:string;provider:string;expires_at:string}
export type ToolPolicy='blocked'|'ask'|'allowed';
export interface McpBinding { name:string; credentialId:string; prefix:string }
export interface McpConfig { name:string; transport:'stdio'|'http'; command:string; args:string[]; url:string; env:Record<string,string>; bindings:McpBinding[]; oauth:boolean; oauthClientId?:string;oauthMetadataUrl?:string;oauthRedirectPort?:number }
export interface ManagedServer { metadata_revision?:string|null; policy:ToolPolicy; trust_updates?:boolean; id:string; config:McpConfig; enabled:boolean; revision:number }
export interface ManagedTool { server_id:string; name:string; definition:{name:string;description?:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>;annotations?:Record<string,unknown>}; contract_fingerprint?:string|null; fingerprint:string; policy:ToolPolicy; blocked_reason?:'new'|'changed'|'member'|null; previous_definition?:ManagedTool['definition']|null; changed_at?:string|null; last_used_at?:string|null; runs?:number }
export interface ToolApproval {platform_sharing:boolean;destination:string;server_name:string;invocation_id:string|null;id:string;run_id:string;server_id:string;tool_name:string;input:unknown;state:string;created_at:string;expires_at:string;decided_at:string|null;consumed_at:string|null}
export interface McpMetadataSnapshot {serverName:string;destination:string;instructions:string;tools:ManagedTool['definition'][]}
export interface McpMetadataRevision {id:string;source_id:string;observed_at:string;fingerprint:string;previous_fingerprint:string|null;summary:string;snapshot:McpMetadataSnapshot}
export type McpMetadataSummary=Omit<McpMetadataRevision,'snapshot'> & {snapshot:Pick<McpMetadataSnapshot,'serverName'|'destination'>};
export interface McpManagementAPI {
 metadataHistory(server:string,before?:string):Promise<{items:McpMetadataSummary[];next:string|null}>;
 metadataRevision(id:string):Promise<McpMetadataRevision>;
 oauthStatus(id:string):Promise<{state:string}>;
 oauthStart(id:string):Promise<void>;
 oauthCancel(id:string):Promise<void>;
 oauthDisconnect(id:string):Promise<void>;
 serverPolicy(server:string,policy:ToolPolicy):Promise<void>;
 trustUpdates(server:string,trusted:boolean):Promise<void>;
 takePermissions(take:string):Promise<TakeToolPermission[]>;
 setTakePermission(take:string,server:string,tool:string,policy:ToolPolicy|null):Promise<void>;
 history(filter:{takeId?:string|null;before?:string}):Promise<{items:ToolInvocation[];next:string|null}>;
 platformSettings():Promise<{verify:boolean;revision:number}>;
 configurePlatformAccess(verify:boolean):Promise<{verify:boolean;revision:number}>;
 platformPending():Promise<PlatformAccessRequest[]>;
 decidePlatformAccess(id:string,approved:boolean):Promise<void>;
 list():Promise<{servers:ManagedServer[];tools:ManagedTool[]}>;
 save(id:string|null,config:McpConfig):Promise<string>;
 enable(id:string,enabled:boolean):Promise<void>;
 remove(id:string):Promise<void>;
 discover(id:string):Promise<void>;
 policy(server:string,tool:string,policy:ToolPolicy):Promise<void>;
 approvals():Promise<ToolApproval[]>;
 decide(id:string,approved:boolean):Promise<void>;
 toolAccessRequests(messageId:string):Promise<ToolAccessRequest[]>;
 decideToolAccess(id:string,approved:boolean):Promise<unknown>;
}

export interface TakeToolPermission {server_id:string;tool_name:string;policy:ToolPolicy}
export interface ToolInvocation {metadata_revision?:string|null;id:string;sequence:string;run_id:string;take_id:string;take_title:string;provider:string;server_name:string;tool_name:string;destination:string;state:string;approval_mode:string;platform_sharing:boolean;started_at:string;dispatched_at:string|null;finished_at:string|null;detail:string;duration_ms:number}
