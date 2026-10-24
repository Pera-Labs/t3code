# Upstream PR branches

Fixes that belong upstream are prepared on this fork as single-commit branches without
`// fork:` markers, so a pull request against `pingdotgg/t3code` can be opened from them.
Opening the PR is a manual step; the fork never opens upstream PRs on its own.

The branches sit on the fork's `main` mirror (`9a391eb3f5`) rather than on `upstream/main`:
pushing a branch that carries upstream's newer `.github/workflows/*` files is refused until the
GitHub token has the `workflow` scope. The touched files did not change upstream since that base,
except for one unrelated hunk in `OrchestratorMcpToolkit.integration.test.ts`, so each commit is
content-identical to the one verified on `upstream/main` (`2c592a1086`).
Rebase onto `upstream/main` before opening once the scope is there.

| Branch                     | Commit       | Change                                                                                                                                             | Verified on Windows (upstream/main + change)                                                                       |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pr/check-changed-windows` | `70b12219df` | `scripts/check-changed.ts` runs the workspace vp entry through node on win32; Node cannot spawn the vp.cmd shim                                    | before: every step `spawn vp ENOENT`; after: all 9 steps spawn, 8 pass, the test step reports the two issues below |
| `pr/path-harness-windows`  | `11f3a90a48` | `ProviderTurnStartService.test.ts` harness takes an optional platform `Path` for the two real-filesystem cases                                     | before: 2 failed, 30 passed; after: 32 passed                                                                      |
| `pr/fixture-path-windows`  | `5a864d23a3` | `OrchestratorMcpToolkit.integration.test.ts` resolves the delegated task status fixture URL through `Path.fromFileUrl` instead of the URL pathname | before: 2 failed (NotFound on a `/C:/...` path); after: 2 passed                                                   |

Open with (one per branch, body from the matching section below):

```
gh pr create -R pingdotgg/t3code --base main --head Pera-Labs:pr/check-changed-windows \
  --title "chore(scripts): run vp through node in check:changed on Windows" --body-file body.md
```

## Windows status at upstream/main 2c592a1086

With the three fixes applied on top of `2c592a1086`, `vp run check:changed` passes all nine
steps on Windows (unused patches, format, lint, knip, graphql, typecheck for 32 packages, test
with 114 files in scope: 72 files run, 1274 passed, 3 skipped). No other code change was needed.

One environment requirement remains and is not a code issue: `src/preview/ServerBrowserPage.test.ts`
launches the Playwright chromium headless shell, so install it once per machine from `apps/server`
with `pnpm exec playwright-core install chromium-headless-shell` (about 270 MB under the
Playwright browsers directory). Without it the test step fails with "Executable doesn't exist".

## Body for pr/check-changed-windows

On Windows, `vp run check:changed` fails before running a single check: Node cannot spawn
the `vp.cmd` shim without a shell, so every step dies with `spawn vp ENOENT`, and so does the
lockfile check that spawns `vp install --lockfile-only`.

This change keeps spawning `vp` from PATH on every other platform. On win32 it runs the
workspace copy of the vp entry script (`node_modules/vite-plus/bin/vp`) through
`process.execPath` instead, for the lockfile check and for every step.

Verification: Windows 11, Node 26.12.1, pnpm 12.14.0. Before, every step failed immediately
with `spawn vp ENOENT`. With this change all nine steps spawn and run; unused patches, format,
graphql (2), lint, knip (2) and typecheck pass. The test step runs the 113 files and reports
Windows-only failures unrelated to spawning (a POSIX `Path.layer` in
`ProviderTurnStartService.test.ts`, which has its own PR, and a fixture path built from a URL
pathname in `OrchestratorMcpToolkit.integration.test.ts`, which also has its own PR). No
behaviour change elsewhere.

## Body for pr/path-harness-windows

The two `coordinates provider startup` cases in `ProviderTurnStartService.test.ts` create a
real temp worktree through `NodeServices` (whose `Path` is `node:path`), but the harness hands
the service the generic `Path.layer`, which is POSIX-only. On Windows the service sees a
different spelling of the same path: the lease key (`path.resolve`) no longer matches the key
the test holds, so the two fibers are not serialized, and `isManagedWorktreePath` rejects the
path, so the missing worktree is never recreated.

The harness now takes an optional `Path` service next to the optional `FileSystem`, and only
the real-filesystem test passes the platform one. The other cases keep `Path.layer` on
purpose: their fixtures are POSIX strings.

Verification: Windows 11, Node 26.12.1. Before: `2 failed | 30 passed (32)`, both
`coordinates provider startup` cases. After: `32 passed (32)`. Unchanged on macOS, where the
platform Path is POSIX as well.

## Body for pr/fixture-path-windows

The two delegated task status cases in `OrchestratorMcpToolkit.integration.test.ts` read
their replay fixture from a path built with `decodeURIComponent(url.pathname)`. On Windows
that string starts with a slash before the drive letter (`/C:/...`), so
`FileSystem.readFileString` reports NotFound and both cases fail before the toolkit is
exercised.

The test now resolves the fixture URL through the `Path` service with `fromFileUrl`, the same
conversion `readProviderReplayTranscript` in `provider-testing` already uses for its fixtures.
Behaviour is unchanged on POSIX, where `fromFileUrl` returns the same path as the pathname.

Verification: Windows 11, Node 26.12.1. Before: `2 failed (2)`, both with
`PlatformError: NotFound`. After: `2 passed (2)`. Formatted and linted with vp; the server
typecheck reports no errors.
