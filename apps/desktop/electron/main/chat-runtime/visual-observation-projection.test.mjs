import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAnthropicToolResultContent,
  createGeminiVisualObservationParts,
  createOpenAIVisualObservationMessage,
} from './visual-observation-projection.mjs';
import { encodeOpenAIResponsesRequest } from '../provider-encoders/responses-encoder.mjs';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const OBSERVATION = {
  kind: 'browser_screenshot',
  mediaType: 'image/png',
  artifactRef: 'local-browser-artifact://shot-1',
  dataUrl: PNG_DATA_URL,
};

function executionsWith(observations) {
  return [{
    call: { toolCallId: 'call-1', name: 'browser_screenshot' },
    result: { output: '{"artifactRef":"local-browser-artifact://shot-1"}', visualObservations: observations },
  }];
}

describe('browser visual observation projection', () => {
  it('projects a screenshot into OpenAI image content and Responses input_image', () => {
    const message = createOpenAIVisualObservationMessage(executionsWith([OBSERVATION]));
    assert.equal(message.role, 'user');
    assert.deepEqual(message.content[1], {
      type: 'image_url',
      image_url: { url: PNG_DATA_URL },
    });

    const encoded = encodeOpenAIResponsesRequest({
      model: 'gpt-5',
      messages: [message],
      tools: [],
    });
    const inputImage = encoded.input[0].content.find((part) => part.type === 'input_image');
    assert.deepEqual(inputImage, { type: 'input_image', image_url: PNG_DATA_URL });
  });

  it('projects a screenshot into Anthropic base64 image content', () => {
    const content = createAnthropicToolResultContent(executionsWith([OBSERVATION])[0].result);
    assert.equal(content[0].type, 'text');
    assert.deepEqual(content.at(-1), {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    });
  });

  it('projects a screenshot into Gemini inlineData', () => {
    const parts = createGeminiVisualObservationParts(executionsWith([OBSERVATION]));
    assert.deepEqual(parts.at(-1), {
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('does not inline ordinary artifact results', () => {
    const executions = executionsWith([]);
    executions[0].result.output = '{"artifactRef":"local-shell-artifact://shell-1"}';
    assert.equal(createOpenAIVisualObservationMessage(executions), null);
    assert.deepEqual(createGeminiVisualObservationParts(executions), []);
    assert.equal(createAnthropicToolResultContent(executions[0].result), executions[0].result.output);
    assert.equal(executions[0].result.output.includes('base64'), false);
  });

  it('ignores malformed visual side-band data without changing tool output', () => {
    const executions = executionsWith([{ ...OBSERVATION, dataUrl: 'file:///tmp/screenshot.png' }]);
    assert.equal(createOpenAIVisualObservationMessage(executions), null);
    assert.deepEqual(createGeminiVisualObservationParts(executions), []);
    assert.equal(createAnthropicToolResultContent(executions[0].result), executions[0].result.output);
  });
});
