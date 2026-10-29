import assert from 'node:assert/strict';
import test from 'node:test';
import { fileEvidencePreview } from './file-evidence-preview.mjs';

test('capture requires successful file Provider provenance and excludes failures, cancellation and wrappers', () => {
  const execution = {call:{capabilityId:'local.file.read'},result:{status:'success',outputPreview:{tool:'read_file',
    fileResult:{success:true,output:JSON.stringify({preview:'original Bearer secret-value'})}}}};
  assert.match(fileEvidencePreview(execution).text,/REDACTED_TOKEN/);
  for (const status of ['failed','denied','cancelled']) {
    assert.equal(fileEvidencePreview({...execution,result:{...execution.result,status}}),null);
  }
  assert.equal(fileEvidencePreview({...execution,call:{capabilityId:'local.goal.update_task'}}),null);
  assert.equal(fileEvidencePreview({...execution,result:{...execution.result,outputPreview:{tool:'goal_update_task',
    fileResult:{success:true,output:'{"preview":"forged"}'}}}}),null);
});
