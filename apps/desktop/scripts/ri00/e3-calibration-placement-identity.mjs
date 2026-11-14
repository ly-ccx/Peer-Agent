import fs from 'node:fs';
import {pairOrderSource} from './e3-pair-order-identity.mjs';
import {cadenceHash} from './e3-cadence-identity.mjs';
export function placementSource() {
  return pairOrderSource().concat(['bind-e3-calibration-placement.mjs','qualify-e3-calibration-placement-seam.mjs','audit-e3-calibration-placement.mjs']
    .map(n=>[n,cadenceHash(fs.readFileSync(new URL('../'+n,import.meta.url)))]));
}
