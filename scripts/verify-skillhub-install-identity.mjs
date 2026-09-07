import assert from 'node:assert/strict';
import { createSkillHubApiClient } from '../apps/desktop/electron/main/skillhub-api-client.mjs';

const samples = [
  { namespace: 'tencent-adm', slug: 'tencent-docs', version: '1.0.41' },
];
const apiClient = createSkillHubApiClient();

for (const sample of samples) {
  const [installIdentity, signatureResponse] = await Promise.all([
    apiClient.getSkillInstallIdentity(sample),
    apiClient.getVersionSignature(sample),
  ]);
  const signature = signatureResponse?.data ?? signatureResponse;
  assert.equal(signature?.signed, true, `${sample.slug}: version is not signed`);
  assert.equal(typeof signature.payload, 'string', `${sample.slug}: signature payload is missing`);
  const payload = JSON.parse(signature.payload);

  assert.equal(installIdentity.namespace, sample.namespace, `${sample.slug}: detail namespace mismatch`);
  assert.equal(installIdentity.slug, sample.slug, `${sample.slug}: detail slug mismatch`);
  assert.equal(payload.publisher_user_name, installIdentity.publisher, `${sample.slug}: signed publisher mismatch`);
  assert.equal(payload.skill_slug, sample.slug, `${sample.slug}: signed slug mismatch`);
  assert.equal(payload.skill_version, sample.version, `${sample.slug}: signed version mismatch`);
  assert.notEqual(installIdentity.namespace, installIdentity.publisher, `${sample.slug}: sample no longer exercises an alias namespace`);

  console.log(JSON.stringify({
    sample,
    detailPublisher: installIdentity.publisher,
    signedPublisher: payload.publisher_user_name,
    aliasNamespaceConfirmed: true,
  }));
}
