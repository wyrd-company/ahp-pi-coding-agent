import type {
  AgentInfo,
  Message,
  StateAction,
  StringOrMarkdown,
  ToolCallResult,
  ToolDefinition as AhpToolDefinition,
  ToolResultContent,
} from '@microsoft/agent-host-protocol';
import {
  createAgentSession as createDefaultPiAgentSession,
  defineTool,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type {
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
} from '@wyrd-company/ahp-provider-kit';
import {
  ActiveClientToolRouter,
  MarkdownTurnEmitter,
  singleModelAgentInfo,
  stringOrMarkdown,
  uriToPath,
} from '@wyrd-company/ahp-provider-kit';

export interface PiCodingAgentSessionLike {
  prompt(text: string, options?: { expandPromptTemplates?: boolean; streamingBehavior?: 'steer' | 'followUp'; source?: string }): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  abort(): Promise<void> | void;
  getActiveToolNames?(): string[];
  setActiveToolsByName?(toolNames: string[]): void;
}

export interface PiCodingAgentSessionFactoryOptions extends Omit<CreateAgentSessionOptions, 'cwd' | 'customTools'> {
  readonly cwd: string;
  readonly customTools?: PiToolDefinition[];
}

export type PiCodingAgentSessionFactory = (
  options: PiCodingAgentSessionFactoryOptions,
) => Promise<{ session: PiCodingAgentSessionLike } & Omit<Partial<CreateAgentSessionResult>, 'session'>>;

export interface PiCodingAgentProviderOptions extends Omit<CreateAgentSessionOptions, 'cwd' | 'customTools'> {
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel?: string;
  readonly createAgentSession?: PiCodingAgentSessionFactory;
  readonly customTools?: readonly PiToolDefinition[];
  readonly createSessionOptions?: (
    context: AgentSessionContext,
  ) => Partial<PiCodingAgentSessionFactoryOptions> | Promise<Partial<PiCodingAgentSessionFactoryOptions>>;
}

export function createPiCodingAgentProvider(options: PiCodingAgentProviderOptions = {}): AgentProvider {
  const providerId = options.providerId ?? 'pi-coding-agent';
  const defaultModel = options.defaultModel ?? 'pi-coding-agent';
  const agent: AgentInfo = singleModelAgentInfo({
    providerId,
    displayName: options.displayName ?? 'Pi Coding Agent',
    description: options.description ?? 'Pi coding agent SDK adapter',
    defaultModel,
  });

  return {
    agent,
    async createSession(context: AgentSessionContext): Promise<AgentSession> {
      const cwd = context.workingDirectory ? uriToPath(context.workingDirectory) : process.cwd();
      const activeClientTools = new ActiveClientToolRouter({
        activeClientTools: context.activeClientTools,
        sink: context.activeClientToolSink,
      });
      const turnState: PiCodingAgentTurnState = {};
      const ahpToolNamesAtCreation = new Set(context.activeClientTools?.tools.map(tool => tool.name) ?? []);
      const sessionOptions = await options.createSessionOptions?.(context) ?? {};
      const createAgentSession = options.createAgentSession ?? defaultPiAgentSessionFactory;
      const created = await createAgentSession({
        ...stripProviderOptions(options),
        ...sessionOptions,
        cwd,
        customTools: [
          ...(options.customTools ?? []),
          ...(sessionOptions.customTools ?? []),
          ...toPiActiveClientTools(context.activeClientTools?.tools ?? [], activeClientTools, turnState),
        ],
      });
      const session = new PiCodingAHPAgentSession(
        created.session,
        activeClientTools,
        ahpToolNamesAtCreation,
        turnState,
      );
      session.setActiveClientTools(context.activeClientTools);
      return session;
    },
  };
}

class PiCodingAHPAgentSession implements AgentSession {
  private activeTurn?: {
    readonly turnId: string;
    readonly markdown: MarkdownTurnEmitter;
    readonly sink: AgentTurnSink;
    completed: boolean;
  };
  private readonly knownAhpToolNames: Set<string>;

  constructor(
    private readonly piSession: PiCodingAgentSessionLike,
    private readonly activeClientTools: ActiveClientToolRouter,
    knownAhpToolNames: ReadonlySet<string>,
    private readonly turnState: PiCodingAgentTurnState,
  ) {
    this.knownAhpToolNames = new Set(knownAhpToolNames);
  }

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const activeTurn = {
      turnId: ahpTurnId,
      markdown: new MarkdownTurnEmitter(sink, ahpTurnId),
      sink,
      completed: false,
    };
    this.activeTurn = activeTurn;
    const unsubscribe = this.piSession.subscribe(event => {
      this.handlePiEvent(event, activeTurn);
    });
    const abort = (): void => {
      void this.piSession.abort();
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      this.turnState.turnId = ahpTurnId;
      await this.piSession.prompt(message.text, { expandPromptTemplates: true, source: 'ahp' });
      if (!activeTurn.completed && !signal.aborted) {
        activeTurn.markdown.complete();
        activeTurn.completed = true;
      }
    } catch (error) {
      sink.emit({
        type: 'session/error',
        turnId: ahpTurnId,
        error: {
          errorType: 'pi-coding-agent.error',
          message: error instanceof Error ? error.message : String(error),
        },
      } as StateAction);
    } finally {
      signal.removeEventListener('abort', abort);
      unsubscribe();
      if (this.turnState.turnId === ahpTurnId) {
        this.turnState.turnId = undefined;
      }
      if (this.activeTurn === activeTurn) {
        this.activeTurn = undefined;
      }
    }
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools.setActiveClientTools(activeClientTools);
    for (const tool of activeClientTools?.tools ?? []) {
      if (this.knownAhpToolNames.has(tool.name)) {
        continue;
      }
      this.knownAhpToolNames.add(tool.name);
    }
    this.syncActiveTools();
  }

  async cancel(): Promise<void> {
    await this.piSession.abort();
  }

  async dispose(): Promise<void> {
    await this.piSession.abort();
  }

  private syncActiveTools(): void {
    if (!this.piSession.getActiveToolNames || !this.piSession.setActiveToolsByName) {
      return;
    }
    const activeAhpToolNames = new Set(this.activeClientTools.tools?.map(tool => tool.name) ?? []);
    const activeTools = this.piSession.getActiveToolNames()
      .filter(toolName => !this.knownAhpToolNames.has(toolName));
    for (const toolName of activeAhpToolNames) {
      activeTools.push(toolName);
    }
    this.piSession.setActiveToolsByName([...new Set(activeTools)]);
  }

  private handlePiEvent(event: AgentSessionEvent, activeTurn: { turnId: string; markdown: MarkdownTurnEmitter; sink: AgentTurnSink; completed: boolean }): void {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      activeTurn.markdown.emitDelta(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === 'tool_execution_start') {
      if (this.knownAhpToolNames.has(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallStart',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        displayName: event.toolName,
      } as StateAction);
      activeTurn.sink.emit({
        type: 'session/toolCallReady',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        invocationMessage: event.toolName,
        toolInput: JSON.stringify(event.args ?? {}),
        confirmed: 'not-needed',
      } as StateAction);
      return;
    }
    if (event.type === 'tool_execution_update') {
      if (this.knownAhpToolNames.has(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallDelta',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        content: stringifyUnknown(event.partialResult),
      } as StateAction);
      return;
    }
    if (event.type === 'tool_execution_end') {
      if (this.knownAhpToolNames.has(event.toolName)) {
        return;
      }
      activeTurn.sink.emit({
        type: 'session/toolCallComplete',
        turnId: activeTurn.turnId,
        toolCallId: event.toolCallId,
        result: piToolResultToAhpResult(event.toolName, event.result, event.isError),
      } as StateAction);
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
      activeTurn.sink.emit({
        type: 'session/error',
        turnId: activeTurn.turnId,
        error: {
          errorType: 'pi-coding-agent.error',
          message: event.message.errorMessage ?? 'Pi coding agent assistant turn failed',
        },
      } as StateAction);
      activeTurn.completed = true;
      return;
    }
    if (event.type === 'agent_end' && !activeTurn.completed) {
      activeTurn.markdown.complete();
      activeTurn.completed = true;
    }
  }
}

function toPiActiveClientTools(
  tools: readonly AhpToolDefinition[],
  activeClientTools: ActiveClientToolRouter,
  turnState: PiCodingAgentTurnState,
): PiToolDefinition[] {
  return tools.map(tool => defineTool({
    name: tool.name,
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    promptSnippet: tool.description ?? tool.title ?? tool.name,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: 'object' }),
    execute: async (toolCallId, params) => {
      const result = await activeClientTools.reportInvocation({
        turnId: turnState.turnId ?? 'turn-unknown',
        toolCallId,
        toolName: tool.name,
        toolInput: JSON.stringify(params ?? {}),
      });
      if (!result.success) {
        throw new Error(result.error?.message ?? stringOrMarkdown(result.pastTenseMessage));
      }
      return {
        content: ahpToolResultToPiContent(result),
        details: result,
      };
    },
  }));
}

interface PiCodingAgentTurnState {
  turnId?: string;
}

function ahpToolResultToPiContent(result: ToolCallResult): Array<{ type: 'text'; text: string }> {
  if (result.content?.length) {
    return result.content.map(content => ({ type: 'text' as const, text: ahpToolContentToText(content) }));
  }
  if (result.structuredContent) {
    return [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
  }
  if (result.error?.message) {
    return [{ type: 'text', text: result.error.message }];
  }
  return [{ type: 'text', text: stringOrMarkdown(result.pastTenseMessage) }];
}

function ahpToolContentToText(content: ToolResultContent): string {
  if (content.type === 'text') {
    return content.text;
  }
  return JSON.stringify(content);
}

function piToolResultToAhpResult(toolName: string, result: unknown, isError: boolean): ToolCallResult {
  const content = piToolResultContent(result);
  return {
    success: !isError,
    pastTenseMessage: isError ? `${toolName} failed` : `${toolName} completed`,
    ...(content ? { content: [{ type: 'text', text: content } as ToolResultContent] } : {}),
    ...(isError ? { error: { message: content || `${toolName} failed` } } : {}),
  };
}

function piToolResultContent(result: unknown): string | undefined {
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content.map(piContentPartToText).filter(Boolean).join('\n');
      return text || undefined;
    }
    if (typeof result.message === 'string') {
      return result.message;
    }
  }
  return result === undefined ? undefined : stringifyUnknown(result);
}

function piContentPartToText(content: unknown): string {
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  return stringifyUnknown(content);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function defaultPiAgentSessionFactory(options: PiCodingAgentSessionFactoryOptions): Promise<{ session: PiCodingAgentSessionLike } & Omit<Partial<CreateAgentSessionResult>, 'session'>> {
  return createDefaultPiAgentSession(options);
}

function stripProviderOptions(options: PiCodingAgentProviderOptions): Omit<CreateAgentSessionOptions, 'cwd' | 'customTools'> {
  const {
    providerId: _providerId,
    displayName: _displayName,
    description: _description,
    defaultModel: _defaultModel,
    createAgentSession: _createAgentSession,
    createSessionOptions: _createSessionOptions,
    customTools: _customTools,
    ...sessionOptions
  } = options;
  return sessionOptions;
}
