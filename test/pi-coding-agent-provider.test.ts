import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  AhpServer,
  FileSystemSessionStore,
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

test('Pi coding agent provider resumes a persisted AHP session by recreating its Pi coding session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-resume-'));
  const secondPi = new FakePiCodingAgentSession();
  const sessionUri = 'ahp-session:/pi-coding-resume';
  let resumedOptions: PiCodingAgentSessionFactoryOptions | undefined;
  let firstSessionFile: string | undefined;
  let firstSessionId: string | undefined;

  try {
    const firstServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          createAgentSession: async options => {
            firstSessionFile = options.sessionManager?.getSessionFile();
            firstSessionId = options.sessionManager?.getSessionId();
            return {
              session: new FakePiCodingAgentSession({
                sessionFile: firstSessionFile,
                sessionId: firstSessionId,
              }),
            };
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });
    await firstClient.shutdown();

    const store = new FileSystemSessionStore({ directory });
    assert.ok(firstSessionFile);
    assert.ok(firstSessionId);
    assert.deepEqual(store.getSession(sessionUri)?.providerResumeState, {
      sessionFile: firstSessionFile,
      sessionId: firstSessionId,
    });
    writeFileSync(firstSessionFile, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: firstSessionId,
      timestamp: new Date().toISOString(),
      cwd: '/workspaces/project-a',
    })}\n`);

    const secondServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          createAgentSession: async options => {
            resumedOptions = options;
            return { session: secondPi };
          },
        }),
      ],
      store,
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'pi-coding-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.equal(resumedOptions?.cwd, '/workspaces/project-a');
    assert.equal(resumedOptions?.sessionManager?.getSessionFile(), firstSessionFile);
    assert.equal(resumedOptions?.sessionManager?.getSessionId(), firstSessionId);

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'resume-turn',
      message: userMessage('Continue after reconnect'),
    } as StateAction);

    await waitFor(() => secondPi.prompts.length === 1);
    secondPi.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Resumed Pi coding', contentIndex: 0, partial: assistantMessage() }, message: assistantMessage() });
    secondPi.emit({ type: 'agent_end', messages: [assistantMessage()], willRetry: false });
    secondPi.releasePrompt();

    const actions = await collectUntilTerminal(subscription);
    assert.deepEqual(secondPi.prompts, ['Continue after reconnect']);
    assert.equal(actions.at(-1)?.type, 'session/turnComplete');

    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi coding agent provider roots new sessions under static sessionStorage', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-static-'));
  const sessionUri = 'ahp-session:/pi-coding-storage-static';
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;

  try {
    const server = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(storageRoot).href,
          createAgentSession: async options => {
            createdOptions = options;
            return {
              session: new FakePiCodingAgentSession({
                sessionFile: options.sessionManager?.getSessionFile(),
                sessionId: options.sessionManager?.getSessionId(),
              }),
            };
          },
        }),
      ],
    });
    const client = createClient(server);
    client.connect();
    await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });

    assert.equal(
      createdOptions?.sessionManager?.getSessionDir(),
      join(storageRoot, 'session-ahp-session_3A_2Fpi-coding-storage-static'),
    );
    assert.equal(
      createdOptions?.sessionManager?.getSessionFile()?.startsWith(`${createdOptions.sessionManager.getSessionDir()}/`),
      true,
    );

    await client.request('disposeSession', { channel: sessionUri });
    await client.shutdown();
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Pi coding agent provider roots new sessions under resolver sessionStorage', async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-resolver-'));
  const sessionUri = 'ahp-session:/pi-coding-storage-resolver';
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;
  let receivedSessionUri: string | undefined;

  try {
    const server = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: context => {
            receivedSessionUri = context.sessionUri;
            return pathToFileURL(storageDir).href;
          },
          createAgentSession: async options => {
            createdOptions = options;
            return {
              session: new FakePiCodingAgentSession({
                sessionFile: options.sessionManager?.getSessionFile(),
                sessionId: options.sessionManager?.getSessionId(),
              }),
            };
          },
        }),
      ],
    });
    const client = createClient(server);
    client.connect();
    await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });

    assert.equal(receivedSessionUri, sessionUri);
    assert.equal(createdOptions?.sessionManager?.getSessionDir(), storageDir);

    await client.request('disposeSession', { channel: sessionUri });
    await client.shutdown();
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('Pi coding agent provider prefers explicit sessionManager over sessionStorage', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-explicit-'));
  const explicitManager = SessionManager.inMemory('/workspaces/explicit');
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;

  try {
    const server = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(storageRoot).href,
          createSessionOptions: () => ({ sessionManager: explicitManager }),
          createAgentSession: async options => {
            createdOptions = options;
            return { session: new FakePiCodingAgentSession() };
          },
        }),
      ],
    });
    const client = createClient(server);
    client.connect();
    await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await client.request('createSession', {
      channel: 'ahp-session:/pi-coding-explicit-manager',
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });

    assert.equal(createdOptions?.sessionManager, explicitManager);

    await client.request('disposeSession', { channel: 'ahp-session:/pi-coding-explicit-manager' });
    await client.shutdown();
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Pi coding agent provider prefers provider sessionManager over sessionStorage', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-provider-explicit-'));
  const explicitManager = SessionManager.inMemory('/workspaces/provider-explicit');
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;

  try {
    const server = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(storageRoot).href,
          sessionManager: explicitManager,
          createAgentSession: async options => {
            createdOptions = options;
            return { session: new FakePiCodingAgentSession() };
          },
        }),
      ],
    });
    const client = createClient(server);
    client.connect();
    await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await client.request('createSession', {
      channel: 'ahp-session:/pi-coding-provider-explicit-manager',
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });

    assert.equal(createdOptions?.sessionManager, explicitManager);

    await client.request('disposeSession', { channel: 'ahp-session:/pi-coding-provider-explicit-manager' });
    await client.shutdown();
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Pi coding agent provider prefers per-session sessionManager over provider sessionManager', async () => {
  const providerManager = SessionManager.inMemory('/workspaces/provider-explicit');
  const perSessionManager = SessionManager.inMemory('/workspaces/per-session-explicit');
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;

  const server = new AhpServer({
    providers: [
      createPiCodingAgentProvider({
        sessionManager: providerManager,
        createSessionOptions: () => ({ sessionManager: perSessionManager }),
        createAgentSession: async options => {
          createdOptions = options;
          return { session: new FakePiCodingAgentSession() };
        },
      }),
    ],
  });
  const client = createClient(server);
  client.connect();
  await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
  await client.request('createSession', {
    channel: 'ahp-session:/pi-coding-per-session-manager',
    provider: 'pi-coding-agent',
    workingDirectory: 'file:///workspaces/project-a',
  });

  assert.equal(createdOptions?.sessionManager, perSessionManager);

  await client.request('disposeSession', { channel: 'ahp-session:/pi-coding-per-session-manager' });
  await client.shutdown();
});

test('Pi coding agent provider resumes from the same sessionStorage directory', async () => {
  const ahpStoreDir = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-resume-store-'));
  const storageRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-resume-root-'));
  const sessionUri = 'ahp-session:/pi-coding-storage-resume';
  let firstSessionFile: string | undefined;
  let firstSessionId: string | undefined;
  let resumedOptions: PiCodingAgentSessionFactoryOptions | undefined;

  try {
    const firstServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(storageRoot).href,
          createAgentSession: async options => {
            firstSessionFile = options.sessionManager?.getSessionFile();
            firstSessionId = options.sessionManager?.getSessionId();
            return {
              session: new FakePiCodingAgentSession({
                sessionFile: firstSessionFile,
                sessionId: firstSessionId,
              }),
            };
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory: ahpStoreDir }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });
    await firstClient.shutdown();

    assert.ok(firstSessionFile);
    assert.ok(firstSessionId);
    assert.equal(
      firstSessionFile.startsWith(`${join(storageRoot, 'session-ahp-session_3A_2Fpi-coding-storage-resume')}/`),
      true,
    );
    writeFileSync(firstSessionFile, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: firstSessionId,
      timestamp: new Date().toISOString(),
      cwd: '/workspaces/project-a',
    })}\n`);

    const secondServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(storageRoot).href,
          createAgentSession: async options => {
            resumedOptions = options;
            return { session: new FakePiCodingAgentSession() };
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory: ahpStoreDir }),
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'pi-coding-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });

    assert.equal(reconnect.type, 'snapshot');
    assert.equal(resumedOptions?.sessionManager?.getSessionDir(), join(storageRoot, 'session-ahp-session_3A_2Fpi-coding-storage-resume'));
    assert.equal(resumedOptions?.sessionManager?.getSessionFile(), firstSessionFile);
    assert.equal(resumedOptions?.sessionManager?.getSessionId(), firstSessionId);

    await secondClient.shutdown();
  } finally {
    rmSync(ahpStoreDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Pi coding agent provider resumes after the storage directory moves to a new path', async () => {
  const ahpStoreDir = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-move-store-'));
  const firstRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-move-a-'));
  const secondRoot = mkdtempSync(join(tmpdir(), 'ahp-pi-coding-storage-move-b-'));
  const sessionUri = 'ahp-session:/pi-coding-storage-move';
  const sessionSegment = 'session-ahp-session_3A_2Fpi-coding-storage-move';
  let firstSessionFile: string | undefined;
  let firstSessionId: string | undefined;
  let resumedOptions: PiCodingAgentSessionFactoryOptions | undefined;

  try {
    const firstServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(firstRoot).href,
          createAgentSession: async options => {
            firstSessionFile = options.sessionManager?.getSessionFile();
            firstSessionId = options.sessionManager?.getSessionId();
            return {
              session: new FakePiCodingAgentSession({
                sessionFile: firstSessionFile,
                sessionId: firstSessionId,
              }),
            };
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory: ahpStoreDir }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'pi-coding-agent',
      workingDirectory: 'file:///workspaces/project-a',
    });
    await firstClient.shutdown();

    assert.ok(firstSessionFile);
    assert.ok(firstSessionId);
    writeFileSync(firstSessionFile, `${JSON.stringify({
      type: 'session',
      version: 3,
      id: firstSessionId,
      timestamp: new Date().toISOString(),
      cwd: '/workspaces/project-a',
    })}\n`);

    // Simulate hydration on another machine: content moves, old root disappears.
    cpSync(join(firstRoot, sessionSegment), join(secondRoot, sessionSegment), { recursive: true });
    rmSync(firstRoot, { recursive: true, force: true });

    const secondServer = new AhpServer({
      providers: [
        createPiCodingAgentProvider({
          sessionStorage: pathToFileURL(secondRoot).href,
          createAgentSession: async options => {
            resumedOptions = options;
            return { session: new FakePiCodingAgentSession() };
          },
        }),
      ],
      store: new FileSystemSessionStore({ directory: ahpStoreDir }),
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'pi-coding-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });

    assert.equal(reconnect.type, 'snapshot');
    assert.ok(firstSessionFile);
    assert.equal(
      resumedOptions?.sessionManager?.getSessionFile(),
      join(secondRoot, sessionSegment, basename(firstSessionFile)),
    );
    assert.equal(resumedOptions?.sessionManager?.getSessionId(), firstSessionId);

    await secondClient.shutdown();
  } finally {
    rmSync(ahpStoreDir, { recursive: true, force: true });
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('Pi coding agent provider keeps default session directory without sessionStorage', async () => {
  const cwd = '/workspaces/project-a';
  let createdOptions: PiCodingAgentSessionFactoryOptions | undefined;

  const server = new AhpServer({
    providers: [
      createPiCodingAgentProvider({
        createAgentSession: async options => {
          createdOptions = options;
          return { session: new FakePiCodingAgentSession() };
        },
      }),
    ],
  });
  const client = createClient(server);
  client.connect();
  await client.initialize({ clientId: 'pi-coding-client', protocolVersions: ['0.3.0'] });
  await client.request('createSession', {
    channel: 'ahp-session:/pi-coding-default-storage',
    provider: 'pi-coding-agent',
    workingDirectory: 'file:///workspaces/project-a',
  });

  assert.equal(
    createdOptions?.sessionManager?.getSessionDir(),
    SessionManager.create(cwd).getSessionDir(),
  );
  assert.equal(createdOptions?.sessionManager?.usesDefaultSessionDir(), true);

  await client.request('disposeSession', { channel: 'ahp-session:/pi-coding-default-storage' });
  await client.shutdown();
});

class FakePiCodingAgentSession implements PiCodingAgentSessionLike {
  readonly prompts: string[] = [];
  readonly sessionFile?: string;
  readonly sessionId?: string;
  activeToolNames: string[] = [];
  private readonly listeners = new Set<(event: Parameters<PiCodingAgentSessionLike['subscribe']>[0] extends (event: infer T) => void ? T : never) => void>();
  private release: (() => void) | undefined;

  constructor(options: { sessionFile?: string; sessionId?: string } = {}) {
    this.sessionFile = options.sessionFile;
    this.sessionId = options.sessionId;
  }

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

function createClient(server: AhpServer): AhpClient {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
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
