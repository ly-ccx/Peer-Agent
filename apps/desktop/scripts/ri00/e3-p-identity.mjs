import fs from'node:fs';import{createHash}from'node:crypto';
/** Same complete diagnostic source fingerprint for sealed replay, P0 and P; no personal content. */
export function pInstrumentSource(){return fs.readdirSync(new URL('./',import.meta.url)).filter(n=>/\.(mjs|cjs|py|c)$/.test(n)).sort().map(n=>[n,createHash('sha256').update(fs.readFileSync(new URL('./'+n,import.meta.url))).digest('hex')]).concat(['run-e3-p-preflight.mjs','run-e3-p-qualification.mjs','run-e3-p-return-audit.mjs'].map(n=>[n,createHash('sha256').update(fs.readFileSync(new URL('../'+n,import.meta.url))).digest('hex')]));}
