# Vision integration design

Status: roadmap steps 1 to 4 implemented, step 5 in progress (phase 5a done, see Roadmap and `ideas.md`); the design below is unchanged.
Related: [fork guide](./README.md).

"Vision" is the fork maintainers' private assistant: a long-running agent with its own
memory, provider/model routing, scheduler and messaging lane. It already exposes a small
MCP endpoint (`send_message`, `get_status`, `get_reply`; OAuth, owner-approved) and it
already drives Codex and Claude Code itself. T3 Code is the GUI, thread, checkpoint and
delegation layer. The two integrate in two directions, and both are **optional**: the fork
must keep working as plain T3 Code when neither is configured (the "generic" mode used on
machines where Vision does not exist).

## Direction A — T3 drives Vision (Vision as a provider)

Vision appears next to Codex and Claude as a provider instance, using the existing
**Local ACP command** path. No upstream file changes are needed for this; everything lives
in a new package.

### `packages/vision-acp/` — ACP agent executable

A small Node executable (`vision-acp`) that speaks ACP on stdio to T3 Code and MCP over
HTTP to Vision. It is built on the in-repo `effect-acp` agent side (`packages/effect-acp/src/agent.ts`), so protocol
handling, logging and errors match the rest of the server.

| ACP request from T3        | Bridge behaviour                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`               | Advertise ACP v2 preview; no file-system or terminal client capabilities are required.                                                                                                                                                                                                                                                                                                                             |
| `authenticate`             | One method, `owner-oauth`: performs the loopback OAuth flow against Vision MCP and stores tokens under T3 home. **The owner approves in the browser; the bridge never fills login forms or reads the owner key.**                                                                                                                                                                                                  |
| `session/new`              | Allocate a local session id. Vision keeps a single owner conversation, so a T3 session is a view onto it, not a separate memory.                                                                                                                                                                                                                                                                                   |
| `session/prompt`           | Flatten the prompt blocks to text (files/images → explicit placeholders), call `send_message` with an idempotency key derived from `(sessionId, promptIndex)` so transport retries never double-send. Poll `get_status` no more often than `retry_after_seconds`. Emit `agent_message_chunk` progress ("queued", "running", elapsed), then the final `get_reply` text as the assistant message. Report `end_turn`. |
| `session/cancel`           | Vision has no cancel API. Stop polling, finish the turn as `cancelled`, and leave the Vision request to complete on its own. Document this in the UI text.                                                                                                                                                                                                                                                         |
| `session/set_mode`, models | Advertise exactly one model, `vision`, and no modes. Vision chooses its own provider/model; T3 must not pretend to control them.                                                                                                                                                                                                                                                                                   |

Rules the bridge enforces:

- Secrets come only from environment variables or the token store under T3 home; nothing
  is written to the repository and nothing is logged.
- Never claim a queued/running request is completed; an `interrupted` receipt is surfaced as
  an error with the request id, never retried automatically.
- Recursion guard: the bridge sets `VISION_ACP_BRIDGE=1` in its own environment and refuses
  to start when it is already set. Vision's internal workers already disable their Vision MCP
  client, so Vision → T3 → Vision loops cannot form.
- Text-generation duties (titles, commit messages) stay with a built-in provider; the bridge
  is not used for them (same rule upstream applies to all ACP agents).

### Registering the provider

Through **Settings → Providers → Add provider → Local ACP command**, or headlessly in
`settings.json` under T3 home using the ACP registry provider instance schema
(`packages/provider-acp-registry/src/settings.ts`):

```json
{
  "providerInstances": {
    "vision": {
      "driver": "acpRegistry",
      "displayName": "Vision",
      "enabled": true,
      "config": {
        "source": "local",
        "commandPath": "node",
        "commandArgs": ["<fork checkout>/packages/vision-acp/src/bin.ts"],
        "authMethodId": "owner-oauth",
        "customModels": ["vision"]
      },
      "environment": [{ "name": "VISION_ACP_MCP_URL", "value": "https://<vision host>/mcp" }]
    }
  }
}
```

`commandPath` is the real executable (`node`, or the absolute path of `node.exe` on Windows
when the server's `PATH` may not carry Node 26), because local ACP commands launch without a
shell and `.cmd`/`.bat` wrappers are rejected. The server does not load shell profiles either, so a
`node` that only a version manager (mise, nvm, fnm) puts on the shell `PATH` is invisible to it;
point `commandPath` at the installed binary itself. Node 26 strips TypeScript types natively, so the
bridge runs straight from `src/bin.ts` without a build step. The file lives at
`<T3 home>/userdata/settings.json` for a packaged or service-managed server and at
`<T3 home>/dev/settings.json` for a `dev-runner` server (`vp run dev`, `vp run dev:server`);
the server watches it, so the instance appears without a restart. Leave `environment` out
until a Vision host exists: the bridge then runs in its unavailable mode and every turn returns
a short notice instead of a Vision reply.

Headless check against a `dev-runner` server (the CLI must see the same dev URL as the
server, otherwise it looks for state under `userdata`):

```sh
export VITE_DEV_SERVER_URL=http://localhost:5733
node apps/server/src/bin.ts project add <workspace>
node apps/server/src/bin.ts thread start <workspace> "hello" --provider vision --model vision --wait --json
```

The JSON result carries `"status": "completed"` and the bridge's reply. Without
`VISION_ACP_MCP_URL` that reply is the unavailable notice; with it, the first turn asks for
the owner login until the owner has signed in through Settings → Providers (`owner-oauth`).

The bridge reads `VISION_ACP_MCP_URL` from the instance's environment
overrides and refuses to start when `VISION_ACP_BRIDGE=1` is already set, so a Vision-driven
session can never spawn a second bridge. `VISION_ACP_MCP_URL` must use `https://` unless it
points at a loopback host, and the bridge talks only to that origin.

## Direction B — Vision drives T3 (configuration only)

Vision already consumes MCP servers and runs shell tools, so it can use T3 Code as upstream
intends for outside agents:

- **MCP:** `codex mcp add t3 --url <t3 server>/mcp` followed by the OAuth login, giving Vision
  thread creation, prompting and status inside T3 projects.
- **Host CLI:** `t3 thread start | send | show` from Vision's shell tool for scripted work.

Unattended threads started this way should use the **Auto** or **Full access** permission
mode; **Supervised** would block on approvals nobody is watching. No fork code is needed.

## Generic mode

With no Vision configuration present the fork behaves like upstream. Fork additions that
are not Vision-specific (see the roadmap) must not import from `packages/vision-acp/`.

## Roadmap

1. `packages/vision-acp/` skeleton (done): `initialize`/`session/new`/`session/prompt`/
   `session/cancel` on the `effect-acp` agent side, a `VisionClient` service with an
   "unavailable" layer, tests over in-memory stdio with a fake client.
2. MCP client with owner OAuth (done): discovery, dynamic client registration, PKCE
   authorization through a loopback redirect on `127.0.0.1`, refresh-token rotation and a
   token store under T3 home (`$T3CODE_HOME/vision-acp/credentials.json`, default
   `~/.t3/vision-acp/`, override with `VISION_ACP_STATE_DIR`). The Streamable HTTP MCP
   transport maps Vision tool errors to client errors and retries once after refreshing the
   owner token. Tests run against fake OAuth and MCP servers on loopback ports.
3. Register as a Local ACP command on the Windows host (done, headless): the `settings.json`
   entry above, then `t3 project add` and `t3 thread start --provider vision --model vision
   --wait` against a `dev-runner` server; the ACP registry driver spawns the bridge, completes
   the handshake and returns its reply. Still open: the same turn from the web UI once a
   browser is paired.
4. Same on the macOS host (done, headless): the same `settings.json` under the dev state
   directory, `commandPath` set to the Node 26 binary inside the version manager's install
   directory, same `project add` and `thread start` check; the reply came back on the first
   attempt.
5. Ideas re-implemented (not copied) from other agent UIs (in progress): the overlap survey
   and the first design are in [`ideas.md`](./ideas.md). Editor pane and usage already exist
   upstream, dictation is an iOS-only feature today, cross-thread notes are missing, so the
   first feature is notebooks: own package, own database file, generic mode first.
