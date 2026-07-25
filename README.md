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

## Session Resume

The provider implements `ResumableAgentProvider`. When `ahp-server` reloads a
persisted AHP session, the adapter recreates the Pi coding-agent SDK session from
the stored AHP working directory, model/config context, and active-client tools.
For new sessions the adapter supplies `SessionManager.create(cwd)` when no
explicit `sessionManager` is provided. Once Pi exposes `sessionFile` and
`sessionId`, the adapter stores them through `AgentSession.getResumeState()` and
uses `SessionManager.open(sessionFile)` after an AHP server restart.

Consumers can still provide a fully configured Pi `sessionManager`; stored
provider resume state takes precedence during resume so an interrupted AHP
session continues the same Pi transcript.

The provider also accepts `sessionStorage` from
`@wyrd-company/ahp-provider-kit`. When `sessionStorage` resolves a directory for
an AHP session, and no explicit Pi `sessionManager` was provided either on the
provider or from `createSessionOptions(...)`, the adapter creates or opens the Pi
`SessionManager` with that directory. This keeps the Pi JSONL session history
under the resolved storage directory so the directory plus the provider resume
state is enough to resume the transcript on another machine or path.

Storage precedence is:

1. Explicit `sessionManager` from `createSessionOptions(...)`.
2. Explicit provider-level `sessionManager`.
3. Resolved `sessionStorage` directory.
4. The existing Pi SDK default session directory behavior.

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

## Releasing

[Intentional](https://github.com/wyrd-company/intentional) is the version and
release-intent authority for this repository. `.intentional/config.yml` defines
the single `ahp-pi-coding-agent` release unit, `package.json` is a projection of that state,
and Git tags are the released-version record. Do not hand-edit the version in
`package.json`.

Continuous integration runs `intentional check` on every pull request and on
`main`. It validates only; it never releases.

### Record a change

Author an intent alongside the implementation it describes:

```bash
intentional add --release-unit ahp-pi-coding-agent:minor --message "Add a user-visible capability."
```

Use `major`, `minor`, or `patch` for the compatibility impact of the change.
While the package is below `1.0.0`, the configured `compatibility` mapping
shifts each bump down one position: a `major` intent moves the minor number and
both `minor` and `patch` intents move the patch number. Commit the generated
file in `.intentional/intents/` with the code change.

### Cut a release

Releasing is a deliberate, human-authorized action. Nothing below happens
automatically.

```bash
intentional status
intentional check
intentional plan > release-plan.json
intentional apply --dry-run
intentional apply

git add -A
git commit -m "chore: release"
```

`apply` writes the new version into `package.json`, updates `CHANGELOG.md`, and
consumes the included intents.

`main` accepts changes only through a pull request, so open one for the release
commit and merge it. Then tag the merged commit on `main`:

```bash
git switch main && git pull
intentional tag --plan release-plan.json
```

`tag` creates the annotated release record using the plain `N.N.N` tag name that
the CD workflow expects. Pushing that tag starts publication and is the point of
no return:

```bash
git push origin <version>
```

`.github/workflows/cd.yml` reacts to the tag: it verifies the tag matches
`package.json`, builds, publishes to npmjs and GitHub Packages, and creates the
GitHub release. Delete `release-plan.json` once the release is tagged; it is
working material, not repository state.
