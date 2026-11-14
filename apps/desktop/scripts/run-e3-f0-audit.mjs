import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { auditE3F0 } from './ri00/e3-f0-audit.mjs';

const args=process.argv.slice(2), required=['--report','--seal','--output'];
for(const key of required)if(!args.includes(key)||!args[args.indexOf(key)+1])throw Error('e3_f0_audit_explicit_arguments_required');
const option=key=>args[args.indexOf(key)+1],hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(option('--report')),seal=JSON.parse(fs.readFileSync(option('--seal'),'utf8'));
if(hash(bytes)!==seal.rawReceiptSha256)throw Error('e3_f0_audit_seal_mismatch');
const report=JSON.parse(bytes);
if(JSON.stringify(report.fixedOrder)!==JSON.stringify(seal.fixedOrder)||report.hypothesisConclusion!=='insufficient-qualified-pairs')throw Error('e3_f0_audit_original_identity_mismatch');
const result={...auditE3F0(report),parentReceiptSha256:hash(bytes),source:[new URL(import.meta.url),new URL('./ri00/e3-f0-audit.mjs',import.meta.url),new URL('./ri00/dense-residual.mjs',import.meta.url)]
  .map(file=>({relative:file.pathname.split('/').at(-1),sha256:hash(fs.readFileSync(file))})),
  notFieldCause:true,originalFailuresRetained:true,originalReportUnchanged:hash(fs.readFileSync(option('--report')))===hash(bytes)};
fs.writeFileSync(option('--output'),JSON.stringify(result),{mode:0o600,flag:'wx'});
console.log(JSON.stringify(result.totals));
