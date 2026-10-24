# Ideas from other agent UIs

Status: roadmap step 5. Decision recorded 2026-10-24: the first feature is **notebooks**
(cross-thread notes). Surveyed against upstream `6c21798485`.

## Rule

Ideas only. The projects we look at for inspiration are not necessarily licensed for reuse, so
nothing is copied: no code, no assets, no UI copy. Every feature here is written from scratch
against T3 patterns (`docs/internals/`), lands as its own package or behind a setting, and works
in generic mode (no Vision) first.

## Overlap survey

| Idea                    | T3 today                                                                                                                                                        | Verdict                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-window editor pane   | The `files` and `file` right-panel surfaces open `FilePreviewPanel`, which edits and saves through `useFileSaveCoordinator` (`apps/web/src/components/files/`). | Already exists. Nothing to build.                                                                                                                                                                                                                                                                                      |
| Usage and cost estimate | Usage page (`docs/user/usage.md`), `ComposerUsageLimits`, `ContextWindowMeter`.                                                                                 | Exists. A per-turn cost column is an extension, later: model rates live only in `apps/server/src/usage/usagePricing.ts`, so it needs a fork RPC for rates plus a per-turn token display the web client does not have yet.                                                                                              |
| Local dictation         | Shared controller in `packages/client-runtime/src/voice-input/`; transcription is implemented on iOS only (`docs/internals/voice-input.md`).                    | Extension, later: the contract transcribes a recorded file (`transcribe(uri)`), so a web or desktop transcriber needs an audio-blob backend; the browser SpeechRecognition API streams live and does not fit. The web and desktop clients do not mount the voice controller yet, so the UI wiring is part of the work. |
| Cross-thread notes      | None. Handoffs (`docs/internals/context-handoffs.md`) move a budgeted slice of history into one new thread once; nothing durable is shared by several threads.  | Missing. First feature.                                                                                                                                                                                                                                                                                                |
| Lightweight shell       | T3 already ships web, desktop and mobile clients.                                                                                                               | Not applicable.                                                                                                                                                                                                                                                                                                        |

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

- 5a. Done (`06e8e30927`): `packages/contracts/src/fork/notes.ts` and `packages/vision-notes/`
  (own `fork-notes.sqlite`, Migrator, repositories, `NotesService`), 18 tests on in-memory
  SQLite plus a reopen-the-file persistence test. No UI.
- 5b. Done (`579a5ea42b`): `notes.*` RPCs (`packages/contracts/src/fork/notesRpc.ts`, handlers in
  `apps/server/src/ws.ts`), `@t3tools/vision-notes/layer` provided by the server, and the "Notes"
  right-panel surface (`apps/web/src/components/fork/notes/`, state in
  `apps/web/src/state/fork/notes.ts`): notebook picker, create, link to thread, add, edit, pin,
  delete. Storage failures surface as `NotesStorageError` on the wire.
- 5c. Done (`1568f33de9`): MCP toolkit `apps/server/src/mcp/toolkits/notes/` registered in
  `McpHttpServer.ts` with fork markers. Tools `t3_notebook_list`, `t3_note_list` (pinned first,
  cursor/limit, 200-char preview), `t3_note_read`, `t3_note_write` (create or update; a thread
  is the author of what it writes). No capability needed; a thread stays in its own project, a
  client that is not a thread passes `projectId`, a read-only client cannot write. The test
  runs the production registration over the in-memory layer: a note written from a thread
  lands in the thread's notebook, which is the notebook the panel lists through `notes.*`.
  The browser check of the panel itself still waits for pairing on a real server.
- 5d-1. Done (`a14eeb3ec7`): context injection. At turn start the pinned notes of the thread's
  notebook follow the user text in a `<t3_notes version="1" notebook notebookId [omitted]>`
  envelope with one `<note id title updatedAt>` per note (`packages/vision-notes/src/provider-context.ts`,
  wired in `ProviderTurnStartService.ts` with fork markers). Caps: 8 notes, 2000 chars per
  note, 8000 chars in total; the omitted count is in the envelope. Nested t3 markup in a body
  is escaped. The service reads `NotesService` through `serviceOption`, so upstream layer
  compositions and tests are untouched and a runtime without a notes store keeps the plain
  text; `server.ts` provides the store to the orchestration runtime. A thread without its own
  notebook resolves to the project default notebook, so its pinned notes reach every thread
  of the project. Storage failures and defects only log; the turn always starts.
- 5d-1 follow-up. Done: a native session receives the full pinned set once, then a one-line
  `<t3_notes ... unchanged="true">` marker (it points at `t3_note_list`) on every later turn
  until a pinned note changes (full set again) or every note is unpinned (`cleared="true"`
  once). The memory is per server process and per native thread id (`makePinnedNotesMemory`,
  256 sessions), so a fresh native session, a server restart and a context handoff to a new
  native thread all resend the full set; a turn counts as delivered only when it reaches
  `startRootRun`. A two-turn test runs the marker through the real service.
- 5d-1 follow-up. Done: the notes file lives in the server state directory next to
  `statev2.sqlite` (`<state>/fork-notes.sqlite`, `VISION_NOTES_DB_PATH` still overrides), so a dev
  server and the packaged one never share notes. Verified end to end on a running dev server:
  an agent turn wrote a pinned note with `t3_note_write` and a new thread of the same project
  received it in `<t3_notes>`.
- 5d-2. Optional: Vision mirror and a `note` composer context kind.

### Out of scope

Copying code, UI or copy from any other project. Notebooks across projects. Replicating notes
between T3 servers: a notebook lives on the server that owns the project, and remote clients
see it through RPC like other project data.
