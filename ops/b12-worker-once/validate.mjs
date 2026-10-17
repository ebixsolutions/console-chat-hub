import {readFileSync} from 'node:fs';
import {SCOPE,validateReceipt,guards} from './executor.mjs';
export function validateFinal(receipt) {
  return receipt?.state==='PASS' && receipt.spent===true && receipt.send_attempts===1
    && receipt.retry===0 && receipt.redirect===0 && receipt.credential_export===false
    && receipt.authentication_metadata_writes===0 && receipt.binding_unchanged===true
    && receipt.full_rows_unchanged===true && validateReceipt(receipt.response)
    && JSON.stringify(receipt.scope)===JSON.stringify(SCOPE)
    && guards(receipt.before) && guards(receipt.after)
    && Number.isFinite(Date.parse(receipt.started_at)) && Number.isFinite(Date.parse(receipt.ended_at))
    && Date.parse(receipt.ended_at)>=Date.parse(receipt.started_at);
}
// Receipt file is non-secret. Never echo its contents or a parse exception.
if(process.argv[1] && import.meta.url===new URL(process.argv[1],'file://').href) {
  let accepted=false;try{accepted=validateFinal(JSON.parse(readFileSync(process.argv[2],'utf8')));}catch{}
  console.log(JSON.stringify({bounded_receipt_assertions:accepted?'PASS':'FAIL',
    evidence_limit:'Still requires actual Edge execution correlation, fresh Work full-row readback, and cumulative ledger review.'}));
  process.exitCode=accepted?0:1;
}
