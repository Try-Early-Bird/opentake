import type {ReactNode} from 'react';
import type {InspectedSourceField} from '../../../shared/data-sources';
import {Select} from '../components/ui/select';
import {mappingFieldItems,type MappingRole} from './mapping-suggestions';
/** Shared destination label for editable sampled fields and platform presets. */
export function MappingRow({label,children}:{label:string;children:ReactNode}){
 return <div className="space-y-2 text-sm"><div className="font-medium">{label}</div>{children}</div>;
}
export function MappingField({id,label,role,fields,value,onChange,type,disabled=false,sampled=true}:{id:string;label:string;role:MappingRole;fields:{key:string;field:InspectedSourceField}[];value:string;onChange(value:string):void;type?:'string'|'number';disabled?:boolean;sampled?:boolean}){
 return <MappingRow label={label}><Select id={id} ariaLabel={label} value={value} onValueChange={onChange} className="w-full" disabled={disabled} items={mappingFieldItems(fields,role,value,type,sampled)}/></MappingRow>;
}
