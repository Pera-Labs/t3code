# Fork guide

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT).
Upstream stays the source of truth for the product; the fork adds an agent-automation layer
(see [Integration design](#integration-design)) and keeps pulling upstream continuously.

## Branch model

| Branch   | Role                                                       | Rules                                   |
| -------- | ---------------------------------------------------------- | --------------------------------------- |
| `main`   | pristine mirror of `upstream/main`                         | fast-forward only, never commit here    |
| `vision` | integration branch: `main` + fork commits (default branch) | upstream arrives by merge, never rebase |

Remotes: `origin` = this fork, `upstream` = `https://github.com/pingdotgg/t3code.git` (push disabled).

## Pulling upstream

```sh
scripts/fork/sync-upstream.sh            # fetch, ff main, merge main into vision (local only)
scripts/fork/sync-upstream.sh --check    # also run `vp i` + `vp run check:changed`
scripts/fork/sync-upstream.sh --push     # push main right after its ff, vision after the merge
```

Exit codes: `0` ok or already current, `2` merge conflict (aborted, tree clean: resolve by hand
on `vision`, commit, rerun; a conflict that only touches `pnpm-lock.yaml` is resolved
automatically by taking upstream's lockfile and regenerating), `3` checks failed (merge kept
locally, nothing pushed), `4` origin rejected the `main` push (`vision` untouched), `65` dirty
tree.

With `--push` the mirror is pushed before the merge on purpose: when origin refuses `main`, it
would refuse `vision` for the same reason, and the integration branch would be left with a merge
commit that cannot be published. The usual cause of a `4` is a token without the `workflow`
scope while upstream changed something under `.github/workflows/`; fix the token, rerun.

`.github/workflows/fork-sync.yml` runs the same script every six hours on the fork and opens
(or comments on) a `fork-sync` issue when a human is needed. It never runs in the upstream repo.
Until the fork token can push workflow files, that commit lives on the `fork-ci-sync` branch
and a scheduled job on a maintainer machine runs `sync-upstream.sh --check --push` instead.

Upstream cadence is several nightly tags per day; stable tags are `vX.Y.Z`. Merging often keeps
each conflict small.

## Keeping merges cheap

Every line changed in an upstream file is a future conflict. Keep fork code out of upstream files:

1. New code lives in new directories: `packages/vision-*`, `scripts/fork/`, `docs/fork/`.
   Register new workspace packages in `pnpm-workspace.yaml` only through its glob patterns.
2. Prefer configuration over code: provider instances, environment overrides, project settings,
   `t3.json`, MCP connections. Most integration needs no fork code at all.
3. When an upstream file must change, keep the edit minimal and mark it:
   `// fork: <reason>` on the line or block. Grep `fork:` before every upstream merge.
4. No secrets, machine names, user names, private addresses or local paths in commits. This is a
   public repository.
5. Upstream `CLAUDE.md` / `AGENTS.md` keep applying; fork rules add to them and are kept here.

## Toolchain

`vp` (Vite+) is the only tool to install; it pins Node 26 from `package.json`. Windows:
install `vp` globally into a Node 26 that is first on `PATH`, then run `vp i` and `vp run dev`
from the repository root. `vp run check:changed` (and so `sync-upstream.sh --check`) runs the
workspace `vp` entry through `node` on Windows, because Node cannot spawn the `vp.cmd` shim
without a shell (fork change in `scripts/check-changed.ts`). The server test suite also passes on
Windows: the `ProviderTurnStartService` test harness takes the platform `Path` for the tests that
touch the real filesystem, because the generic `Path.layer` is POSIX-only (fork change in the test
file). Full runbook: [docs/operations/development.md](../operations/development.md).

## Known fork limitations

- Upstream CI (`ci.yml`) targets Blacksmith runners that only exist in the upstream org. On the
  fork those jobs would queue forever, so they are disabled; use `--check` locally or a
  self-hosted runner.
- Desktop/server self-update points at upstream releases. A fork build that must ship its own
  binaries needs its own release pipeline (`release-desktop.yml`, `release.yml`) and update feed.
  Until then the fork is run from source (`vp run dev`, `vp run build`).

## Integration design

Full design: [vision-integration.md](./vision-integration.md).

Target: one control surface for coding agents on Windows and macOS, driven by an external
automation agent (our "Vision" system) and also usable as a plain personal/team tool.

Two directions, both covered by upstream features, no fork code required:

1. **Outside agent drives T3 Code.** The automation agent connects to an environment's
   `/mcp` endpoint (OAuth, read-only through full access) or uses `t3 thread start|send|show`
   on the host. Threads run under the provider and permission mode the project allows.
   See [docs/user/outside-agents.md](../user/outside-agents.md).
2. **T3 Code drives the automation agent.** The agent is added as a _Local ACP command_
   provider, so it appears next to Codex and Claude Code with projects, threads, checkpoints and
   task delegation managed by T3 Code. See [docs/user/providers-acp.md](../user/providers-acp.md).

Fork work therefore concentrates on: an ACP adapter on the agent side, presets and scripts that
wire environments across the two hosts (LAN / Tailscale), and documentation. Features seen in
other tools (in-window editor pane, local dictation, usage forecast, cross-thread notes) are
re-implemented from scratch when adopted; code from unlicensed projects is never copied.

## Upstream PR branches

Fixes meant for `pingdotgg/t3code` are prepared as marker-free branches; see
`docs/fork/upstream-prs.md` for the list, the verification and the PR bodies.
