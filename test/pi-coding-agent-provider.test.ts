import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';
import {
  createPiCodingAgentProvider,
  type PiCodingAgentSessionFactoryOptions,
  type PiCodingAgentSessionLike,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Pi coding agent provider streams real Pi SDK session events as AHP actions', async () => {
  const pi = new FakePiCodingAgentSession();
  const server = new AhpServer({
    providers: [
      createPiCodingAgentProvider({
        createAgentSession: async () => ({ session: pi }),
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-coding-agent-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-coding-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('Hello Pi'),
  } as StateAction);

  await waitFor(() => pi.prompts.length === 1);
  pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi ', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() });
  pi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'says hi', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() });
  pi.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
  pi.releasePrompt();

  const actions = await collectUntilTerminal(subscription);
  assert.deepEqual(pi.prompts, ['Hello Pi']);
  assert.equal(actions.some(action => action.type === 'session/responsePart'), true);
  assert.equal(
    actions
      .filter((action): action is StateAction & { content: string } => action.type === 'session/delta')
      .map(action => action.content)
      .join(''),
    'Pi says hi',
  );
  assert.equal(actions.at(-1)?.type, 'session/turnComplete');

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Pi coding agent provider maps Pi coding tool events to AHP server-side tool lifecycle', async () => {
  const pi = new FakePiCodingAgentSession();
  const server = new AhpServer({
    providers: [
      createPiCodingAgentProvider({
        createAgentSession: async () => ({ session: pi }),
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-coding-agent-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-coding-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-tools',
    message: userMessage('Read the file'),
  } as StateAction);

  await waitFor(() => pi.prompts.length === 1);
  pi.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } });
  pi.emit({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' }, partialResult: { content: [{ type: 'text', text: 'partial' }] } });
  pi.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false });
  pi.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
  pi.releasePrompt();

  const actions = await collectUntilTerminal(subscription);
  const toolStart = actions.find(action => action.type === 'session/toolCallStart');
  assert.ok(toolStart);
  assert.equal(toolStart.toolCallId, 'tool-1');
  assert.equal(toolStart.toolName, 'read');
  assert.equal(toolStart.contributor, undefined);

  const toolReady = actions.find(action => action.type === 'session/toolCallReady');
  assert.ok(toolReady);
  assert.equal(toolReady.toolInput, JSON.stringify({ path: 'README.md' }));

  const toolComplete = actions.find(action => action.type === 'session/toolCallComplete');
  assert.ok(toolComplete);
  assert.equal(toolComplete.result.success, true);
  assert.deepEqual(toolComplete.result.content, [{ type: 'text', text: 'contents' }]);

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Pi coding agent provider registers initial active-client tools as Pi custom tools', async () => {
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;
  const pi = new FakePiCodingAgentSession();
  const server = new AhpServer({
    providers: [
      createPiCodingAgentProvider({
        createAgentSession: async options => {
          createdOptions = options;
          return { session: pi };
        },
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'owner-client', protocolVersions: ['0.3.0'] });

  const tool = toolDefinition('searchWorkspace', 'Search Workspace');
  const sessionUri = 'ahp-session:/pi-active-client-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-coding-agent',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [tool],
    },
  });

  assert.deepEqual(createdOptions?.customTools?.map(candidate => candidate.name), ['searchWorkspace']);
  assert.deepEqual(pi.activeToolNames, ['searchWorkspace']);

  client.dispatch(sessionUri, {
    type: 'session/activeClientChanged',
    activeClient: null,
  } as StateAction);
  await waitFor(() => pi.activeToolNames.length === 0);

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

class FakePiCodingAgentSession implements PiCodingAgentSessionLike {
  readonly prompts: string[] = [];
  activeToolNames: string[] = [];
  private readonly listeners = new Set<(event: Parameters<PiCodingAgentSessionLike['subscribe']>[0] extends (event: infer T) => void ? T : never) => void>();
  private release: (() => void) | undefined;

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    await new Promise<void>(resolve => {
      this.release = resolve;
    });
  }

  subscribe(listener: (event: Parameters<PiCodingAgentSessionLike['subscribe']>[0] extends (event: infer T) => void ? T : never) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Parameters<PiCodingAgentSessionLike['subscribe']>[0] extends (event: infer T) => void ? T : never): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  releasePrompt(): void {
    this.release?.();
    this.release = undefined;
  }

  abort(): void {
    this.releasePrompt();
  }

  getActiveToolNames(): string[] {
    return this.activeToolNames;
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeToolNames = toolNames;
  }
}

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      subscription.next(),
      new Promise<IteratorResult<never>>(resolve => setTimeout(
        () => resolve({ done: true, value: undefined as never }),
        100,
      )),
    ]);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (next.done || value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    const type = value.params.action.type;
    if (type === 'session/turnComplete' || type === 'session/error') {
      break;
    }
  }
  return actions;
}

function assistantMessage(): never {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    provider: 'fake',
    model: 'fake',
    api: 'fake',
    stopReason: 'stop',
    usage: {},
    timestamp: Date.now(),
  } as never;
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
