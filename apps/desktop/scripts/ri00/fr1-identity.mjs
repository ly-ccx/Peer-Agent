import fs from'node:fs';import{createHash}from'node:crypto';import{pInstrumentSource}from'./e3-p-identity.mjs';
export const fr1Hash=x=>createHash('sha256').update(x).digest('hex');
export function fr1Source(){return pInstrumentSource().concat(['qualify-fr1.mjs','bind-fr1.mjs','run-fr1.mjs'].map(n=>[n,fr1Hash(fs.readFileSync(new URL('../'+n,import.meta.url)))]));}
