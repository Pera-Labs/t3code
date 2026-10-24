# Ideas from other agent UIs

Status: roadmap step 5. Decision recorded 2026-10-24: the first feature is **notebooks**
(cross-thread notes). Surveyed against upstream `6c21798485`.

## Rule

Ideas only. The projects we look at for inspiration are not necessarily licensed for reuse, so
nothing is copied: no code, no assets, no UI copy. Every feature here is written from scratch
against T3 patterns (`docs/internals/`), lands as its own package or behind a setting, and works
in generic mode (no Vision) first.

## Overlap survey

| Idea                    | T3 today                                                                                                                                                        | Verdict                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| In-window editor pane   | The `files` and `file` right-panel surfaces open `FilePreviewPanel`, which edits and saves through `useFileSaveCoordinator` (`apps/web/src/components/files/`). | Already exists. Nothing to build.                                                     |
| Usage and cost estimate | Usage page (`docs/user/usage.md`), `ComposerUsageLimits`, `ContextWindowMeter`.                                                                                 | Exists. A per-turn cost column would be an extension, later.                          |
| Local dictation         | Shared controller in `packages/client-runtime/src/voice-input/`; transcription is implemented on iOS only (`docs/internals/voice-input.md`).                    | Extension: a desktop or web transcriber that plugs into the existing contract, later. |
| Cross-thread notes      | None. Handoffs (`docs/internals/context-handoffs.md`) move a budgeted slice of history into one new thread once; nothing durable is shared by several threads.  | Missing. First feature.                                                               |
| Lightweight shell       | T3 already ships web, desktop and mobile clients.                                                                                                               | Not applicable.                                                                       |

## Notebooks (v1 design)

A notebook is a durable set of Markdown notes attached to a project. Every thread of that
project can read and append to it. Agents reach notes through T3's MCP toolkit, the user reads
and edits them in a right-panel surface. Notes are neither a transcript nor a handoff: they hold
decisions, constraints and reminders that outlive a single thread.

Generic first: no Vision dependency and no provider-specific branch. Mirroring a Vision topic
into a notebook is a later step and belongs to `packages/vision-acp` or configuration, not to
the notebook package.

### Data model

- Notebook: `notebookId`, `projectId`, `title`, `createdAt`, `updatedAt`. Scoped to the
  environment that owns the project, like every other project resource.
- Note: `noteId`, `notebookId`, `title`, `body` (Markdown, bounded length), `author` (`user`
  or the writing `threadId`), `pinned`, `createdAt`, `updatedAt`.
- Thread link: `threadId` to `notebookId`, optional. One notebook per thread, many threads per
  notebook. Without a link a thread uses the project's default notebook, created lazily, so
  most users never pick one.

### Storage

Own SQLite file under the T3 state directory (`fork-notes.sqlite`), built with
`@t3tools/shared/nodeSqliteClient` and its own `effect/sql/Migrator` list. Upstream's
`apps/server/src/persistence/Migrations.ts` is one numbered sequence; a fork migration taking
the next number would collide with upstream's next migration at every merge. A separate file
costs nothing and leaves that sequence untouched. The repository follows
`apps/server/src/persistence/PullRequestReviewGuides.ts`: `SqlSchema` queries, typed
persistence errors, an in-memory layer for tests.

### Packages and touch points

- `packages/vision-notes/`: repository, service, RPC handlers, MCP toolkit, tests. The prefix is
  the fork namespace, not a Vision dependency. Layout as in `packages/vision-acp/`.
- `packages/contracts/src/fork/notes.ts`: schemas, ids and RPC payloads. The contracts package
  cannot depend on a fork package that depends on it, so the wire types live here, in a
  fork-owned folder, and are re-exported from the contracts index with a `// fork: notes` line.
- Upstream files touched, each line marked `// fork: notes`:
  - `packages/contracts/src/rpc.ts`: method names and `Rpc.make` entries for `notes.list`,
    `notes.get`, `notes.put`, `notes.delete`, `notes.linkThread`.
  - `apps/server/src/server.ts`: provide the notes layer. `apps/server/src/mcp/McpHttpServer.ts`:
    register the toolkit next to `ProjectToolkit`.
  - `apps/web/src/rightPanelStore.ts`: `{ id: "notes"; kind: "notes" }`.
    `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`: one `case "notes"`.
- Web components live in `apps/web/src/components/fork/notes/`, a new folder, and follow
  `docs/internals/web-ui.md` (primitives from `components/ui`, React Compiler clean).
- A server setting, default on, hides the surface and withholds the toolkit when off.

### Agent access

Tools named like the existing ones in `apps/server/src/mcp/toolkits/`: `t3_note_list`
(read-only), `t3_note_read` (read-only), `t3_note_write` (create or update, author is the
calling thread). The notebook is resolved from the invocation context's thread; agents never
pass a notebook id in v1. Deleting a note is a user action in the panel, there is no tool for it.

### Context injection (later)

Pinned notes as a composer context record kind `note`, so the provider receives them in the
`<t3_context>` envelope (`docs/internals/composer-context-references.md`). Unknown kinds already
project as JSON; chip rendering needs an entry in the client presentation registry, which is a
fork touch. Deferred until v1 is in use.

### Phases

- 5a. Contracts, repository and service with their own database, tests on in-memory SQLite.
  No UI.
- 5b. RPCs and the web right-panel surface: list, read, edit, pin, default notebook per project,
  thread link picker.
- 5c. MCP toolkit and handlers with tests. Headless check: an agent in a thread writes a note
  and the panel shows it.
- 5d. Optional: Vision mirror and context injection.

### Out of scope

Copying code, UI or copy from any other project. Notebooks across projects. Replicating notes
between T3 servers: a notebook lives on the server that owns the project, and remote clients
see it through RPC like other project data.
