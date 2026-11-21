import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/usage-ledger-v1.json', import.meta.url), 'utf8'));
const output = new URL('../../packages/conversation-store/src/usage-ledger-contract.generated.mjs', import.meta.url);
const body = '// Generated from packages/protocol/contracts/native-cli/usage-ledger-v1.json.\n'
  + `export const USAGE_LEDGER_CONTRACT = ${JSON.stringify(contract, null, 2)};\n`;
if (process.argv.includes('--update')) writeFileSync(output, body);
else assert.equal(readFileSync(output, 'utf8'), body, 'usage ledger contract generation drift');
const rustOutput = new URL('../../crates/peer-store/src/usage_ledger_contract.generated.rs', import.meta.url);
const rust = '// Generated from packages/protocol/contracts/native-cli/usage-ledger-v1.json.\n'
  + `pub const ROW_BYTES: usize = ${contract.limits.rowBytes};\n`
  + `pub const INTENT_BYTES: usize = ${contract.limits.intentBytes};\n`
  + `pub const SCHEMA_VERSION: u64 = ${contract.schemaVersion};\n`
  + `pub const INTENT_FILE: &str = ${JSON.stringify(contract.intentFile)};\n`
  + `pub const LEDGER_RELATIVE: &str = ${JSON.stringify(contract.ledgerRelative)};\n`;
if (process.argv.includes('--update')) writeFileSync(rustOutput, rust);
else assert.equal(readFileSync(rustOutput, 'utf8'), rust, 'native usage ledger contract generation drift');
