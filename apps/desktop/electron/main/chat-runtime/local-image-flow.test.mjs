import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalImageProvider, checkpointWithoutLocalImagePixels } from '@peer-agent/runtime-node';
import { createLocalFileProvider } from '../runtime-gateway/local-file-provider.mjs';
import { createRuntimeToolProjection } from '../tools/index.mjs';
import { createAnthropicToolResultContent, createOpenAIVisualObservationMessage, createGeminiVisualObservationParts } from './visual-observation-projection.mjs';
import { encodeOpenAIResponsesRequest } from '../provider-encoders/responses-encoder.mjs';
import { getDesktopPreviewService } from '../runtime-gateway/desktop-preview-service.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('image is available to work, Explorer and read-only Verifier without development preview', () => {
  assert.equal(getDesktopPreviewService(), null);
  for (const mode of ['chat', 'plan', 'goal', 'explorer', 'project_agent']) {
    const projected = createRuntimeToolProjection({ projectionOptions: { mode, readOnlyWorkSession: true } });
    assert.equal(projected.registry.getTool('view_image').runtime.executorCapabilityId, 'local.image.read');
    assert.equal(projected.projection.capabilities.find(c => c.name === 'view_image').health, 'available');
    assert.equal(projected.registry.getTool('desktop_preview'), null);
  }
});
test('text read redirects images; actual authorized pixels reach every provider format', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-wire-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'screenshot.png'); await writeFile(path, PNG);
  const call = { toolCallId: 'image-test', capabilityId: 'local.file.read', arguments: { path } };
  const file = await createLocalFileProvider({ workspaceRoot: root }).executeCapability({ call });
  assert.equal(file.result.status, 'failed');
  assert.match(JSON.stringify(file.result.outputPreview), /image_requires_view_image/);
  assert.doesNotMatch(JSON.stringify(file.result), /�PNG|base64/);
  const execution = await createLocalImageProvider({ workspaceRoot: root, decodeImage: () => ({ width: 1, height: 1 }) }).executeCapability({ call: { ...call, capabilityId: 'local.image.read' } });
  const toolResult = { output: JSON.stringify(execution.result.outputPreview), visualObservations: execution.result.modelContext.visualObservations };
  const executions = [{ call, result: toolResult }];
  const openai = createOpenAIVisualObservationMessage(executions);
  assert.equal(openai.content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  const responses = encodeOpenAIResponsesRequest({ model: 'test-vision', messages: [openai], tools: [] });
  assert.equal(responses.input[0].content[1].type, 'input_image');
  assert.equal(createAnthropicToolResultContent(toolResult).at(-1).source.data, PNG.toString('base64'));
  assert.equal(createGeminiVisualObservationParts(executions).at(-1).inlineData.data, PNG.toString('base64'));
  assert.doesNotMatch(JSON.stringify(checkpointWithoutLocalImagePixels([openai])), /base64|iVBOR/);
  const forged = { ...toolResult, visualObservations: toolResult.visualObservations.map(o => ({ ...o })) };
  assert.equal(createOpenAIVisualObservationMessage([{ result: forged }]), null);
  assert.equal(createAnthropicToolResultContent(forged), toolResult.output);
  assert.deepEqual(createGeminiVisualObservationParts([{ result: forged }]), []);
});
