# AHP Pi Coding Agent Provider

TypeScript provider adapter that lets an AHP server run the real Pi coding agent SDK.

Package target: `@wyrd-company/ahp-pi-coding-agent`.

This package uses `@earendil-works/pi-coding-agent` and its `createAgentSession(...)` SDK. It does not implement an OpenAI-compatible tool loop itself; Pi owns provider selection, model auth, coding tools, extensions, skills, prompt templates, sessions, and tool execution.

## Behavior

- Creates one Pi coding-agent SDK session per AHP session.
- Uses the AHP session working directory as Pi `cwd`.
- Sends each AHP user turn through `AgentSession.prompt(...)`.
- Maps Pi assistant text deltas to AHP markdown response parts and deltas.
- Maps Pi `agent_end` to `session/turnComplete`.
- Maps Pi coding tool execution events to AHP server-side tool call lifecycle actions.
- Aborts the Pi session when AHP cancels or disposes the session.

## Active-Client Tools

The provider maps AHP active-client tools present at session creation into Pi SDK `customTools`.

- Pi executes those custom tools through its normal tool runtime.
- The custom tool implementation routes execution through `ActiveClientToolRouter.reportInvocation(...)`.
- AHP owns session URI, turn id, tool call id, tool name, and active-client identity.
- Only the owning active client can complete the tool through normal AHP `session/toolCallComplete`.

Pi coding-agent custom tools are registered when the Pi session is created. The adapter can enable, disable, and route the registered AHP tool set as active-client ownership changes, but newly introduced tool names after Pi session creation require a new AHP session until Pi exposes a public runtime API for adding SDK custom tool definitions.

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createPiCodingAgentProvider } from '@wyrd-company/ahp-pi-coding-agent';

const server = new AhpServer({
  providers: [
    createPiCodingAgentProvider({
      agentDir: '/workspace/.pi/agent',
    }),
  ],
});
```

You can pass Pi SDK session options directly:

```ts
createPiCodingAgentProvider({
  agentDir: '/workspace/.pi/agent',
  noTools: 'builtin',
  customTools: [mySpecializedTool],
});
```

## Development

```bash
npm install
npm run verify
```
