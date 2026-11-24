import {randomUUID} from 'node:crypto';

const reasonCodes=new Set(['request_completed','request_failed','rate_limited','database_unavailable','invalid_request','worker_scan_failed','worker_attempt_failed','worker_attempt_started','worker_attempt_completed']);
export function boundedReasonCode(value,fallback='request_failed'){return reasonCodes.has(value)?value:fallback;}
export function correlationId(value){return typeof value==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(value)?value:randomUUID();}
export function writeStructuredLog(level,fields,write=console.log){
  const record={timestamp:new Date().toISOString(),level:level==='error'?'error':'info',service:fields.service==='revmarket-worker'?'revmarket-worker':'revmarket-api',event:/^[a-z_]{1,48}$/.test(fields.event||'')?fields.event:'operation',correlationId:correlationId(fields.correlationId),reasonCode:boundedReasonCode(fields.reasonCode)};
  if(Number.isInteger(fields.status)&&fields.status>=100&&fields.status<=599)record.status=fields.status;
  if(Number.isInteger(fields.durationMs)&&fields.durationMs>=0)record.durationMs=fields.durationMs;
  if(Number.isSafeInteger(fields.marketId)&&fields.marketId>=0)record.marketId=fields.marketId;
  if(Number.isInteger(fields.attempt)&&fields.attempt>0)record.attempt=fields.attempt;
  if(['GET','POST','PUT','DELETE','HEAD','PATCH'].includes(fields.method))record.method=fields.method;
  if(typeof fields.route==='string'&&/^\/[a-zA-Z0-9_/:{}.-]{1,120}$/.test(fields.route))record.route=fields.route;
  write(JSON.stringify(record));return record;
}
