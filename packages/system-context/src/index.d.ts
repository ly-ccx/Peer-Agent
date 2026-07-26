export type PromptLayer =
  | 'L0_CORE'
  | 'L1_AGENT'
  | 'L2_RUNTIME'
  | 'L3_INSTRUCTIONS'
  | 'L4_CAPABILITIES'
  | 'L5_TOOL_RULES'
  | 'L6_MODE_REMINDER'
  | 'L7_CONTINUITY';

export interface PromptSection {
  readonly id: string;
  readonly layer: PromptLayer | string;
  readonly priority: number;
  readonly title: string;
  readonly content: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly trust: string;
  readonly checksum: string;
}

export interface SystemContextInput extends Readonly<Record<string, unknown>> {
  readonly workspacePath?: string | null;
  readonly conversationId?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly mode?: string | null;
  readonly effort?: string | null;
  readonly goalPlanStore?: unknown;
  readonly mcpRegistry?: unknown;
  readonly contextAttachments?: readonly unknown[];
  readonly attachmentContext?: readonly unknown[];
  readonly configInstructions?: readonly unknown[];
  readonly contextExtensions?: readonly unknown[];
  readonly runtimeReminders?: readonly unknown[];
  readonly continuityContext?: readonly unknown[];
  readonly explorerContext?: unknown;
  readonly verifierContext?: unknown;
}

export interface PromptSource {
  readonly id: string;
  readonly layer: PromptLayer | string;
  readonly priority?: number;
  readonly trust?: string;
  observe(input: SystemContextInput): unknown;
  render(observation: any, input: SystemContextInput): readonly Partial<PromptSection>[];
}

export interface PromptSourceRegistry {
  register(source: PromptSource): PromptSource;
  getSource(id: string): PromptSource | null;
  listSources(): readonly PromptSource[];
  listSourceIds(): readonly string[];
}

export interface AssembledSystemContext {
  readonly version: 1;
  readonly sections: readonly PromptSection[];
  readonly rendered: string;
  readonly snapshot: {
    readonly id: string;
    readonly createdAt: string;
    readonly conversationId: string | null;
    readonly workspacePath: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly mode: string;
    readonly sectionRefs: readonly {
      readonly id: string;
      readonly layer: string;
      readonly checksum: string;
      readonly source: Readonly<Record<string, unknown>>;
    }[];
    readonly renderedHash: string;
  };
}

export function createPromptSourceRegistry(options?: {
  readonly sources?: readonly PromptSource[];
}): PromptSourceRegistry;
export function createDefaultPromptSourceRegistry(): PromptSourceRegistry;
export function assembleSystemContext(
  input?: SystemContextInput,
  options?: { readonly registry?: PromptSourceRegistry },
): AssembledSystemContext;
export function renderSystemContext(context?: Pick<AssembledSystemContext, 'sections'>): string;

export function renderSystemCorePrompt(): string;
export function renderBrainstormingPrompt(): string;
export function renderRuntimeContext(workspacePath?: string | null): string;

export function createAttachmentPromptSource(): PromptSource;
export function createBrainstormingPromptSource(): PromptSource;
export function createContinuityPromptSource(): PromptSource;
export function createContextExtensionPromptSource(options?: { readonly maxCharsPerExtension?: number }): PromptSource;
export function createCorePromptSource(): PromptSource;
export function createExplorerPromptSource(): PromptSource;
export function createGoalPlanPromptSource(): PromptSource;
export function createGoalRunnerPromptSource(): PromptSource;
export function createMcpHostPromptSource(): PromptSource;
export function createModePromptSource(): PromptSource;
export function createProjectInstructionsPromptSource(options?: Readonly<Record<string, unknown>>): PromptSource;
export function createProviderPromptSource(): PromptSource;
export function createRuntimePromptSource(): PromptSource;
export function createRuntimeReminderPromptSource(): PromptSource;
export function createVerifierPromptSource(): PromptSource;
