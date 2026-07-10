import type {
  ProjectionMaterializer,
  RuntimeProjection,
  RuntimeToolDefinition,
} from './contracts.ts';

export interface OpenAIFunctionToolSchema {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface AnthropicToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

function toolDescription(tool: RuntimeToolDefinition): string {
  return tool.description ?? '';
}

function toolInputSchema(tool: RuntimeToolDefinition): unknown {
  return tool.inputSchema ?? {
    type: 'object',
    properties: {},
  };
}

export function materializeOpenAITools(
  projection: RuntimeProjection,
): readonly OpenAIFunctionToolSchema[] {
  return projection.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: toolDescription(tool),
      parameters: toolInputSchema(tool),
    },
  }));
}

export function materializeAnthropicTools(
  projection: RuntimeProjection,
): readonly AnthropicToolSchema[] {
  return projection.tools.map((tool) => ({
    name: tool.name,
    description: toolDescription(tool),
    input_schema: toolInputSchema(tool),
  }));
}

export const openAIProjectionMaterializer: ProjectionMaterializer<OpenAIFunctionToolSchema> = {
  providerFamily: 'openai',
  materialize: materializeOpenAITools,
};

export const anthropicProjectionMaterializer: ProjectionMaterializer<AnthropicToolSchema> = {
  providerFamily: 'anthropic',
  materialize: materializeAnthropicTools,
};
