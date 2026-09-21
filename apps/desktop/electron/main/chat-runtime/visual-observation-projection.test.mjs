import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAnthropicToolResultContent,
  createGeminiVisualObservationParts,
  createOpenAIVisualObservationMessage,
  INDEPENDENT_VISUAL_REVIEW_PURPOSE,
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

const DESKTOP = {
  kind: 'desktop_preview',
  mediaType: 'image/png',
  artifactRef: 'local-desktop-preview-artifact://shot-2',
  dataUrl: PNG_DATA_URL,
};

function projected(observations, purpose) {
  const executions = executionsWith(observations);
  return {
    openai: createOpenAIVisualObservationMessage(executions, purpose),
    gemini: createGeminiVisualObservationParts(executions, purpose),
    anthropic: createAnthropicToolResultContent(executions[0].result, purpose),
  };
}

describe('desktop preview projection purpose gate', () => {
  it('chat/browser still projects screenshots', () => {
    const got = projected([OBSERVATION]);
    assert.equal(got.openai.content[1].type, 'image_url');
    assert.equal(got.gemini.at(-1).inlineData.mimeType, 'image/png');
    assert.equal(got.anthropic.at(-1).type, 'image');
  });

  it('chat/desktop omits preview images by default', () => {
    const got = projected([DESKTOP]);
    assert.equal(got.openai, null);
    assert.deepEqual(got.gemini, []);
    assert.equal(got.anthropic, executionsWith([DESKTOP])[0].result.output);
  });

  it('chat/unknown-purpose also omits desktop images', () => {
    const got = projected([DESKTOP], 'chat-with-tools');
    assert.equal(got.openai, null);
    assert.deepEqual(got.gemini, []);
    assert.equal(got.anthropic, executionsWith([DESKTOP])[0].result.output);
  });

  it('independent-review/desktop projects preview images', () => {
    const got = projected([DESKTOP], INDEPENDENT_VISUAL_REVIEW_PURPOSE);
    assert.equal(got.openai.content[1].type, 'image_url');
    assert.equal(got.gemini.at(-1).inlineData.data, 'iVBORw0KGgo=');
    assert.equal(got.anthropic.at(-1).type, 'image');
  });

  it('chat/mixed keeps browser and drops desktop', () => {
    const got = projected([OBSERVATION, DESKTOP]);
    assert.equal(got.openai.content.length, 2);
    assert.equal(got.openai.content[1].type, 'image_url');
    assert.equal(got.gemini.length, 2);
    assert.equal(got.anthropic.filter((block) => block.type === 'image').length, 1);
  });

  it('malformed desktop data is omitted even during independent review', () => {
    const got = projected([{ ...DESKTOP, dataUrl: 'file:///tmp/preview.png' }], INDEPENDENT_VISUAL_REVIEW_PURPOSE);
    assert.equal(got.openai, null);
    assert.deepEqual(got.gemini, []);
    assert.equal(got.anthropic, executionsWith([{ ...DESKTOP, dataUrl: 'file:///tmp/preview.png' }])[0].result.output);
  });
});
