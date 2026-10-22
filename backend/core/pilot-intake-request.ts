import {canonical,DomainError,sha} from './model.js';

export type PilotIntakeSourceFormat='DOCX'|'PDF';
export interface PilotIntakeSettings {
 readonly copies:number;readonly duplex:boolean;readonly paper:'A4';readonly color:'black_white';
}
export interface PilotRevisionSourceBinding {
 readonly format:PilotIntakeSourceFormat;readonly sha256:string;readonly size_bytes:number;
 readonly provider_event_id:string;readonly artifact_ref:string;
 readonly settings:PilotIntakeSettings;readonly settings_sha256:string;
 readonly settings_event_ids:readonly string[];
}

const sha256Pattern=/^[0-9a-f]{64}$/;
const artifactPattern=/^doc-[a-f0-9]{32}\/source-000-([a-f0-9]{64})\.(pdf|docx)$/;
const invalid=()=>new DomainError('PILOT_SOURCE_NOT_VERIFIED','Pilot revision source/settings are invalid',409);
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function exactKeys(value:Record<string,unknown>,keys:string[]):boolean{return Object.keys(value).sort().join(',')===keys.slice().sort().join(',');}
function eventId(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256&&
 value===value.trim()&&!/[\u0000-\u0020]/.test(value);}

/**
 * Validates the exact Core request_data shape written after a sealed pilot
 * source and its settings have been bound to a revision. Legacy review requests
 * without `sealed_source` return null and retain their existing validation.
 */
export function pilotRevisionSourceBinding(value:unknown):PilotRevisionSourceBinding|null{
 if(!record(value))throw invalid();
 const pilotKeys=['documents','pilot_settings','pilot_settings_sha256','sealed_source','settings_event_ids'];
 const hasAny=pilotKeys.slice(1).some(key=>Object.hasOwn(value,key));
 if(!hasAny)return null;
 const envelopeKeys=['source','conversation_id','event_ids','text','incoming_batches','supplements'];
 const allowedKeys=new Set([...pilotKeys,...envelopeKeys]);
 if(pilotKeys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowedKeys.has(key))||
    !Array.isArray(value.documents)||value.documents.length!==1||
    !record(value.documents[0])||!record(value.sealed_source)||!record(value.pilot_settings)||
    !Array.isArray(value.settings_event_ids))throw invalid();
 const document=value.documents[0];
 const source=value.sealed_source;
 const settings=value.pilot_settings;
 if(!exactKeys(document,['artifact_name','copies','duplex','paper'])||
    !exactKeys(source,['format','provider_event_id','sha256','size_bytes'])||
    !exactKeys(settings,['color','copies','duplex','paper']))throw invalid();
 const format=source.format;
 const artifactRef=document.artifact_name;
 const sourceSha=source.sha256;
 const size=source.size_bytes;
 if((format!=='DOCX'&&format!=='PDF')||typeof artifactRef!=='string'||
    typeof sourceSha!=='string'||!sha256Pattern.test(sourceSha)||
    !Number.isSafeInteger(size)||Number(size)<1||Number(size)>25*1024*1024||
    !eventId(source.provider_event_id)||!Number.isSafeInteger(settings.copies)||
    Number(settings.copies)<1||Number(settings.copies)>99||typeof settings.duplex!=='boolean'||
    settings.paper!=='A4'||settings.color!=='black_white'||
    document.copies!==settings.copies||document.duplex!==settings.duplex||document.paper!=='A4')throw invalid();
 const match=artifactPattern.exec(artifactRef);
 if(!match||match[1]!==sourceSha||match[2] !== (format==='PDF'?'pdf':'docx'))throw invalid();
 const expectedSettingsHash=sha(canonical(settings));
 if(typeof value.pilot_settings_sha256!=='string'||value.pilot_settings_sha256!==expectedSettingsHash)
  throw invalid();
 const ids=value.settings_event_ids;
 if(ids.length<1||ids.length>100||ids.some(id=>!eventId(id))||new Set(ids).size!==ids.length)
  throw invalid();
 if(Object.hasOwn(value,'source')&&
    (typeof value.source!=='string'||value.source.length<1||value.source.length>64))throw invalid();
 if(Object.hasOwn(value,'conversation_id')&&!eventId(value.conversation_id))throw invalid();
 if(Object.hasOwn(value,'text')&&(typeof value.text!=='string'||value.text.length>4000))throw invalid();
 if(Object.hasOwn(value,'event_ids')){
  const eventIds=value.event_ids;
  if(!Array.isArray(eventIds)||eventIds.length<1||eventIds.length>500||
     eventIds.some(id=>!eventId(id))||new Set(eventIds).size!==eventIds.length||
     !eventIds.includes(source.provider_event_id)||ids.some(id=>!eventIds.includes(id)))throw invalid();
 }
 if(Object.hasOwn(value,'incoming_batches')&&!Array.isArray(value.incoming_batches))throw invalid();
 if(Object.hasOwn(value,'supplements')&&!Array.isArray(value.supplements))throw invalid();
 return {format,sha256:sourceSha,size_bytes:Number(size),provider_event_id:source.provider_event_id,
  artifact_ref:artifactRef,settings:{copies:Number(settings.copies),duplex:settings.duplex,paper:'A4',color:'black_white'},
  settings_sha256:expectedSettingsHash,settings_event_ids:ids as string[]};
}
