# Vision integration design

Status: design accepted for implementation (fork maintainers), no code yet.
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
  "source": "local",
  "commandPath": "node",
  "commandArgs": ["<fork checkout>/packages/vision-acp/src/bin.ts"],
  "authMethodId": "owner-oauth",
  "customModels": ["vision"]
}
```

`commandPath` is the real executable (`node`), because local ACP commands launch without a
shell. Node 26 strips TypeScript types natively, so the bridge runs straight from `src/bin.ts`
without a build step. The bridge reads `VISION_ACP_MCP_URL` from the instance's environment
overrides and refuses to start when `VISION_ACP_BRIDGE=1` is already set, so a Vision-driven
session can never spawn a second bridge.

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
2. MCP client with owner OAuth (loopback redirect), token store under T3 home.
3. Register as a Local ACP command on the Windows host, end-to-end turn from the web UI.
4. Same on the macOS host.
5. Ideas re-implemented (not copied) from other agent UIs: in-window editor pane, local
   dictation, usage/cost forecast, cross-thread notes. Each as its own package or behind a
   setting, generic mode first.
