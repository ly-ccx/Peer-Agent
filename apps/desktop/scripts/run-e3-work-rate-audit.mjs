import fs from'node:fs';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';import{auditPassWorkExperiment}from'./ri00/e3-work-decomposition.mjs';
const args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];for(const k of['--report','--seal','--output'])if(!args.includes(k))throw Error('sealed_work_rate_arguments');
const bytes=fs.readFileSync(option('--report')),seal=JSON.parse(fs.readFileSync(option('--seal'))),hash=b=>createHash('sha256').update(b).digest('hex');
if(!/^[a-f0-9]{64}$/.test(seal.rawReportSha256)||hash(bytes)!==seal.rawReportSha256)throw Error('sealed_work_rate_source_mismatch');
const report=JSON.parse(bytes),audit=auditPassWorkExperiment(report);if(audit.counts.passes!==384)throw Error('sealed_384_pass_dataset_required');
const result={kind:'sealed-offline-work-rate-replay',inputSha256:hash(bytes),originalProducer:report.candidate,analyzerSha256:hash(fs.readFileSync(fileURLToPath(new URL('./ri00/e3-work-decomposition.mjs',import.meta.url)))),audit};
const fd=fs.openSync(option('--output'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(result));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}
console.log(JSON.stringify({readOnlyReplay:true,...audit.counts,originalProducer:report.candidate}));
