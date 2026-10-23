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
scripts/fork/sync-upstream.sh --push     # push main + vision when the merge succeeded
```

Exit `2` means a conflict: the merge was aborted and the tree is clean. Resolve by hand on
`vision`, commit, rerun. A conflict that only touches `pnpm-lock.yaml` is resolved automatically
by taking upstream's lockfile and regenerating.

`.github/workflows/fork-sync.yml` runs the same script every six hours on the fork and opens
(or comments on) a `fork-sync` issue when a human is needed. It never runs in the upstream repo.

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
from the repository root. Full runbook: [docs/operations/development.md](../operations/development.md).

## Known fork limitations

- Upstream CI (`ci.yml`) targets Blacksmith runners that only exist in the upstream org. On the
  fork those jobs would queue forever, so they are disabled; use `--check` locally or a
  self-hosted runner.
- Desktop/server self-update points at upstream releases. A fork build that must ship its own
  binaries needs its own release pipeline (`release-desktop.yml`, `release.yml`) and update feed.
  Until then the fork is run from source (`vp run dev`, `vp run build`).

## Integration design

Target: one control surface for coding agents on Windows and macOS, driven by an external
automation agent (our "Vision" system) and also usable as a plain personal/team tool.

Two directions, both covered by upstream features, no fork code required:

1. **Outside agent drives T3 Code.** The automation agent connects to an environment's
   `/mcp` endpoint (OAuth, read-only through full access) or uses `t3 thread start|send|show`
   on the host. Threads run under the provider and permission mode the project allows.
   See [docs/user/outside-agents.md](../user/outside-agents.md).
2. **T3 Code drives the automation agent.** The agent is added as a *Local ACP command*
   provider, so it appears next to Codex and Claude Code with projects, threads, checkpoints and
   task delegation managed by T3 Code. See [docs/user/providers-acp.md](../user/providers-acp.md).

Fork work therefore concentrates on: an ACP adapter on the agent side, presets and scripts that
wire environments across the two hosts (LAN / Tailscale), and documentation. Features seen in
other tools (in-window editor pane, local dictation, usage forecast, cross-thread notes) are
re-implemented from scratch when adopted; code from unlicensed projects is never copied.
