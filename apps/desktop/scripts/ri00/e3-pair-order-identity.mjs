import fs from 'node:fs';
import {cadenceSource, cadenceHash} from './e3-cadence-identity.mjs';
export function pairOrderSource() {
  return cadenceSource().concat(['run-e3-pair-order.mjs', 'bind-e3-pair-order.mjs', 'qualify-e3-pair-order-seam.mjs']
    .map(name => [name, cadenceHash(fs.readFileSync(new URL('../' + name, import.meta.url)))]));
}
