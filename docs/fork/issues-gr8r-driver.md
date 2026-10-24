# Greater (gr8r) issue tracker driver

Status: design, waiting for the fork owner's go-ahead. Nothing in this document is
implemented yet. Depends on upstream PRs #19259, #19260 and #19274.
Related: [fork guide](./README.md), [Vision integration](./vision-integration.md).

## Decision in one paragraph

The fork should not grow its own task system. Upstream is landing an issue tracking layer
with pluggable trackers (GitHub first, then standalone trackers such as Linear and Jira), and
upstream's maintainers stated on 2026-10-22 that the stack ships as v1. Greater, the private
single-user task workspace the fork owner already runs, fits that layer as one more standalone
tracker: one driver package, one row in the built-in tracker list. The fork then adds only what
upstream does not have yet: starting an agent thread from an issue, showing the linked threads
inside the issue, and an MCP toolkit so the agent can update the issue from inside its own
session. All of that is written against upstream's tracker interface, so it works unchanged for
GitHub, Linear or Jira and nothing Greater-specific leaks into the server or the web app.

Vocabulary: this feature is "Issues", never "Tasks". Upstream already uses "tasks" for
delegated sub-agent work and todo banners inside a thread.

## Upstream state this design is based on

| Upstream PR                                                | What                                                                                                                 | State on 2026-10-24                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| #19259 `issues/1-core` (head `e9773e8014`)                 | `packages/issue-tracker-core`, `IssueService`, registry, GitHub issues driver, RPCs                                  | open, CI green, mergeable, 24 commits |
| #19260 `issues/2-web` (head `57d1d45011`, stacked on core) | `/issues` route, issue detail panel, right panel `issue` surface beside a thread, sidebar entry                      | draft                                 |
| #19274 `issues/5-linear` (head `20703ed464`)               | `StandaloneIssueTrackerApi`, credential store, project bindings (migration), Settings connect/bind UI, Linear driver | draft                                 |

Measured on the fork (scratch worktree, nothing pushed): merging `upstream/main` into
`vision` produces no conflict; merging the `issues/2-web` head on top produces 3 conflicted
files with 5 hunks, every one of them a "keep both" at a fork notes splice point (`ws.ts`,
`RightPanelTabs.tsx`, `rightPanelStore.ts`). The fork can therefore take the stack early or
wait for the upstream merge at about the same cost.

Key interface facts from those branches:

- `IssueTrackerKind` is an open branded string (`^[a-z][a-z0-9-]*$`, max 64), not a closed
  enum, so `gr8r` is a valid kind without touching contracts.
- A driver is `defineIssueTrackerDriver({ kind, make })` yielding an `IssueTrackerApi`:
  `kind`, `capabilities`, `getViewer`, `listIssues`, `getIssue`, `getComments`, and optional
  `create`, `comment`, `update`, `setState`, `setReaction`, `listTemplates`, `listCandidates`.
  The service refuses calls outside the declared capabilities before they reach the driver.
- A standalone tracker additionally carries `standalone: StandaloneIssueTrackerDescriptor`
  (`tracker`, `displayName`, `host`, `scopeNoun`, `credential.label`, `credential.helpUrl`) and
  `probeCredential(token)` returning `{ account, scopes: [{ key, name }] }`. The server stores
  one credential per kind in its secret store, read fresh on each call, and a project binds one
  scope through Settings. The driver never sees where the credential lives.
- Registration is one row in `apps/server/src/issue/builtInIssueTrackers.ts`; the Linear PR body
  says the same about Jira.

## Greater in one paragraph

Greater is a small Node service (about 760 lines) with a browser UI for its owner and a token
protected JSON API under `/api/v1`. State is one JSON document with a global `version` that
every write bumps; a stale `PATCH` answers 409. It knows projects (key, status, task counts,
an optional workflow with stages), tasks (key such as `PROJ-123`, title, HTML description,
status `backlog | todo | progress | review | done`, priority, labels, origin, single optional
assignee `owner`, due/start dates, dependencies, up to 100 subtasks) and comments. There is no
pagination, no search beyond `q=` substring matching, no reactions, no templates and no event
log. The workspace holds a few hundred tasks.

## The driver: `packages/issue-tracker-gr8r`

Kind `gr8r`. Implements `StandaloneIssueTrackerApi` over the platform `HttpClient`, modelled
on the Linear driver (`packages/issue-tracker-linear`).

Descriptor: `displayName` "Greater", `scopeNoun` "project", `credential.label` "API token",
`credential.helpUrl` null. `host` is the host of the configured base URL. Upstream assumes one
host per kind, which matches Greater (single tenant per installation); the base URL comes from
server configuration (environment variable, read when the driver is made), never from the repo.

| Upstream concept                     | Greater                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                              | project key (`GET /projects`)                                                                                                     |
| `key`, `displayKey`                  | task key, same string                                                                                                             |
| `url`                                | the workspace UI link for the task when the UI exposes one, otherwise the API URL                                                 |
| `author`                             | null (Greater records no author); `origin` goes into the body header                                                              |
| `state`                              | `status` mapped below                                                                                                             |
| `assignees`                          | `[owner]` when `assignee === "owner"`, else `[]`                                                                                  |
| `labels`                             | `labels` (name only, no color)                                                                                                    |
| `commentCount`                       | `comments.length` from the detail, 0 in listings that lack it                                                                     |
| `createdAt`, `updatedAt`, `closedAt` | `created`, `updated`; `closedAt` = `updated` when status is `done`, else null                                                     |
| body                                 | description HTML converted to plain Markdown; subtasks appended as a checklist section; priority, due and start as a short header |
| comments                             | `comments[]` (`id`, `at`, `by`, `text`), `url` null, no reactions                                                                 |

States (`capabilities.states`): `backlog`, `todo`, `progress`, `review` with category `open`;
`done` with category `closed`. `closeReasons` empty. `setState` is `PATCH { status }`.

Capabilities: `create`, `edit`, `comment`, `labels`, `search` true; `assignees`, `reactions`,
`templates`, `linkedPullRequests`, `events` false. `listCandidates` returns the labels seen in
the scope so the picker has suggestions.

Calls:

- `probeCredential(token)`: `GET /version` then `GET /projects` with the token. Account is the
  fixed string `owner` (Greater is single user). Scopes are the projects as `{ key, name }`.
  401 is reported as a refused credential, not a failure.
- `getViewer`: `owner`.
- `listIssues`: `GET /tasks?project=<scope>&q=<query>&full=1`, then filter by state category
  (`open` = status other than `done`), by involvement (`assigned` = assignee is owner; the other
  involvements collapse to `all` because Greater has no authorship), sort by `updated`
  descending, apply `limit`, `nextCursor` null. One page is correct for this workspace size.
- `getIssue`: `GET /tasks/<key>` gives task and comments in one read. `getComments` with a
  cursor never has more to give; it returns an empty page.
- `create`: `POST /tasks` with `project`, `title`, `desc`, `labels`; the first assignee, if
  `owner`, becomes `assignee`.
- `update`: `PATCH` with `title`, `desc`, `labels` as present.
- `comment`: `POST /tasks/<key>/comments { text }`.
- 409 from a `PATCH`: re-read the task once and retry the same change; a second 409 surfaces
  as an `IssueTrackerError` with reason `conflict` and the detail from the server.
- Error mapping: 401 `unauthorized`, 404 `not-found`, 400 and 413 `invalid`, network and 5xx
  `unavailable`, everything else `failed`.

Not mapped in v1: workflow stages, dependencies, priority as a first-class field (upstream has
none), subtask editing. They are read-only in the body or absent.

## Fork additions on top of upstream Issues

These are generic over `IssueService`; they do not know which tracker an issue came from.

1. **Start a thread from an issue.** A "Start session" action on the issue detail and in the
   issue row. It calls the existing `launchThread` RPC with a title of `<displayKey> <title>`
   and an initial message built from the issue (key, title, body, url, labels) plus a short
   instruction block. Model, runtime and workspace strategy follow the project's defaults, as
   the composer does. New files under `apps/web/src/components/fork/issues/`, atoms under
   `apps/web/src/state/fork/`.
2. **Issue to thread links.** A small table in the fork's own SQLite layer (new package
   `packages/vision-issues`, modelled on `packages/vision-notes`): `(tracker, host, scope, key,
   threadId, createdAt)`. Written when a thread is started from an issue; read by the issue
   detail to list its threads with their live status, and by the thread header to show the
   issue. If upstream later ships its own thread links (#19576 proposed them), the fork table
   is migrated into it and dropped.
3. **Agent-side MCP toolkit `issues`.** `apps/server/src/mcp/toolkits/issues/` with
   `issues_list`, `issues_get`, `issues_comment`, `issues_set_state`, scoped to the thread's
   project and, when the thread was started from an issue, defaulting to that issue. This is
   how a run reports progress back to Greater, Jira or GitHub without the operator copying
   anything. Same shape as the fork's `notes` toolkit.
4. **Headless credential fallback (optional, fork only).** When the server has no stored
   credential for `gr8r` but an environment variable names a token, the driver uses it so
   unattended servers work without a Settings visit. The value is never logged or echoed back
   through any RPC.

## Portability check

A Jira driver is the same shape: `packages/issue-tracker-jira`, kind `jira`, one row in the
built-in list, descriptor `scopeNoun` "project", states from the Jira workflow with category
by status category. Items 1 to 3 above need no change. Greater is a convenience for the fork
owner's own machines, not a dependency of the feature.

## Rollout

1. Decide between taking the `issues/2-web` head into `vision` now (5 keep-both hunks, then
   typecheck and `check:changed` on Windows and Mac) or waiting for the upstream merge. Either
   way, mark the resolved lines with `// fork:` only where the fork side changed them.
2. Driver package with fixture tests under `@effect/vitest` against a fake HTTP server
   (list, detail, create, update, comment, 409 retry, 401 probe). No network in tests.
3. Start session action and the link table, with tests for the launch input and the table.
4. MCP toolkit, with the same in-memory tests as the notes toolkit.
5. Windows and Mac verification: `check:changed` green on both, a manual run against a real
   Greater instance with a token entered in Settings, and a thread started from an issue that
   comments back on it through the toolkit.

## Open points

- Body format: Greater stores HTML, upstream renders Markdown. Decide between a small HTML to
  Markdown conversion in the driver and showing stripped text.
- Workflow stages have no upstream counterpart. Leave out of v1, revisit if the sidebar needs a
  per-project progress line.
- Whether the issue list should default to the bound Greater project or to every scope the
  token reaches; upstream lists each project's own bound scope, which is probably right.
