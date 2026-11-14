import fs from 'node:fs';
import {fr1Source,fr1Hash} from './fr1-identity.mjs';
export function fr1StageIdentity(){
  return fr1Source().concat([['run-fr1-stage.mjs',fr1Hash(fs.readFileSync(new URL('../run-fr1-stage.mjs',import.meta.url)))]]);
}
