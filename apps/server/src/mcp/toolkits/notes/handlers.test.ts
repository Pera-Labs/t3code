// fork: notes. The notes MCP toolkit through the production registration.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Note,
  type Notebook,
  type NotebookId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as VisionNotes from "@t3tools/vision-notes/layer";
import * as NotesService from "@t3tools/vision-notes/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("mcp-notes-thread");
// The testkit's live thread shell lives in this project.
const projectId = ProjectId.make("project:mcp-test");
const otherProjectId = ProjectId.make("project:mcp-other");

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-notes-environment"),
  requestNamespace: "mcp-notes-session",
  thread: {
    threadId,
    providerSessionId: "mcp-notes-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
};
const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
  ...threadScope,
  thread: undefined,
  client: { sessionId: "mcp-notes-client", label: "notes test client", access: "read-only" },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-notes", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-notes", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerTest = McpHttpServer.layerNotesToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(VisionNotes.layerMemory),
  Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(NodeCrypto.layer),
);

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const callAs = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.fn(function* (name: string, args: Record<string, unknown>) {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const asThread = callAs(threadScope);
const asReadOnlyClient = callAs(readOnlyClientScope);

it.effect("registers the notes tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = server.tools.map(({ tool }) => tool.name).toSorted();
    expect(names).toEqual(["t3_note_list", "t3_note_read", "t3_note_write", "t3_notebook_list"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a thread writes a note into its notebook, lists, reads and pins it", () =>
  Effect.gen(function* () {
    const notebooks = yield* asThread("t3_notebook_list", {});
    expect(notebooks.isError).toBe(false);
    const listed = notebooks.structuredContent as {
      notebooks: ReadonlyArray<Notebook>;
      threadNotebookId: NotebookId | null;
    };
    expect(listed.threadNotebookId).not.toBeNull();
    expect(listed.notebooks.map((n) => n.projectId)).toEqual([projectId]);

    const written = yield* asThread("t3_note_write", {
      title: "Deploy checklist",
      body: "1. run the migrations\n2. restart the server",
    });
    expect(written.isError).toBe(false);
    const note = written.structuredContent as Note;
    expect(note.author).toEqual({ _tag: "thread", threadId });
    expect(note.notebookId).toBe(listed.threadNotebookId);
    expect(note.pinned).toBe(false);

    const list = yield* asThread("t3_note_list", {});
    expect(list.isError).toBe(false);
    const page = list.structuredContent as {
      notebook: Notebook;
      notes: ReadonlyArray<{ noteId: string; bodyPreview: string; bodyLength: number }>;
      nextCursor: number | null;
    };
    expect(page.notebook.notebookId).toBe(note.notebookId);
    expect(page.notes.map((n) => n.noteId)).toEqual([note.noteId]);
    expect(page.notes[0]?.bodyPreview).toBe(note.body);
    expect(page.notes[0]?.bodyLength).toBe(note.body.length);
    expect(page.nextCursor).toBeNull();

    const read = yield* asThread("t3_note_read", { noteId: note.noteId });
    expect(read.isError).toBe(false);
    expect((read.structuredContent as Note).body).toBe(note.body);

    const pinned = yield* asThread("t3_note_write", { noteId: note.noteId, pinned: true });
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({
      noteId: note.noteId,
      title: "Deploy checklist",
      pinned: true,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects incomplete writes with invalid_request", () =>
  Effect.gen(function* () {
    const noBody = yield* asThread("t3_note_write", { title: "Half a note" });
    expect(declaredFailure(noBody)).toMatchObject({ code: "invalid_request" });

    const created = yield* asThread("t3_note_write", { title: "Whole", body: "note" });
    const note = created.structuredContent as Note;
    const noFields = yield* asThread("t3_note_write", { noteId: note.noteId });
    expect(declaredFailure(noFields)).toMatchObject({ code: "invalid_request" });

    const missing = yield* asThread("t3_note_read", { noteId: "note-that-does-not-exist" });
    expect(declaredFailure(missing)).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a thread inside its own project's notebooks", () =>
  Effect.gen(function* () {
    const notes = yield* NotesService.NotesService;
    const foreign = yield* notes.createNotebook({ projectId: otherProjectId, title: "Elsewhere" });

    const list = yield* asThread("t3_note_list", { notebookId: foreign.notebookId });
    expect(declaredFailure(list)).toMatchObject({ code: "invalid_request" });

    const write = yield* asThread("t3_note_write", {
      notebookId: foreign.notebookId,
      title: "Trespass",
      body: "no",
    });
    expect(declaredFailure(write)).toMatchObject({ code: "invalid_request" });

    const byProject = yield* asThread("t3_notebook_list", { projectId: otherProjectId });
    expect(declaredFailure(byProject)).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a read-only client reads with a projectId and cannot write", () =>
  Effect.gen(function* () {
    const noProject = yield* asReadOnlyClient("t3_note_list", {});
    expect(declaredFailure(noProject)).toMatchObject({ code: "target_required" });

    const list = yield* asReadOnlyClient("t3_note_list", { projectId });
    expect(list.isError).toBe(false);
    expect((list.structuredContent as { notes: ReadonlyArray<unknown> }).notes).toEqual([]);

    const notebooks = yield* asReadOnlyClient("t3_notebook_list", { projectId });
    expect(
      (notebooks.structuredContent as { threadNotebookId: unknown }).threadNotebookId,
    ).toBeNull();

    const write = yield* asReadOnlyClient("t3_note_write", { projectId, title: "No", body: "no" });
    expect(declaredFailure(write)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerTest)),
);
