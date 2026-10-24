import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { NotebookId, NoteId, ProjectId, ThreadId } from "@t3tools/contracts";

import * as Repository from "./repository.ts";
import * as Service from "./service.ts";
import * as Sqlite from "./sqlite.ts";

const TestLayer = Service.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("NotesService notebooks", (it) => {
  it.effect("creates the default notebook once per project", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const projectId = ProjectId.make("svc-default");

      const first = yield* service.defaultNotebook(projectId);
      const second = yield* service.defaultNotebook(projectId);

      assert.strictEqual(second.notebookId, first.notebookId);
      assert.strictEqual(first.title, Service.DEFAULT_NOTEBOOK_TITLE);
      assert.isTrue(first.isDefault);
      assert.strictEqual((yield* service.listNotebooks(projectId)).length, 1);
      const other = yield* service.defaultNotebook(ProjectId.make("svc-default-other"));
      assert.notStrictEqual(other.notebookId, first.notebookId);
    }),
  );

  it.effect("lists the default notebook before user notebooks, newest first", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const projectId = ProjectId.make("svc-list");

      const research = yield* service.createNotebook({ projectId, title: "Research" });
      yield* TestClock.adjust("1 minute");
      const fallback = yield* service.defaultNotebook(projectId);
      yield* TestClock.adjust("1 minute");
      const ideas = yield* service.createNotebook({ projectId, title: "Ideas" });

      const listed = yield* service.listNotebooks(projectId);
      assert.deepStrictEqual(
        listed.map((entry) => entry.notebookId),
        [fallback.notebookId, ideas.notebookId, research.notebookId],
      );
      assert.isFalse(ideas.isDefault);
      assert.notStrictEqual(ideas.createdAt, research.createdAt);
    }),
  );

  it.effect("renames and deletes notebooks and reports missing ones", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const projectId = ProjectId.make("svc-rename");
      const created = yield* service.createNotebook({ projectId, title: "Before" });

      yield* TestClock.adjust("1 minute");
      const renamed = yield* service.renameNotebook(created.notebookId, "After");
      assert.strictEqual(renamed.title, "After");
      assert.strictEqual(renamed.createdAt, created.createdAt);
      assert.notStrictEqual(renamed.updatedAt, created.updatedAt);
      assert.strictEqual((yield* service.getNotebook(created.notebookId)).title, "After");

      yield* service.deleteNotebook(created.notebookId);
      const missing = yield* service.getNotebook(created.notebookId).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "NotebookNotFoundError");
      const deleteAgain = yield* service.deleteNotebook(created.notebookId).pipe(Effect.flip);
      assert.strictEqual(deleteAgain._tag, "NotebookNotFoundError");
      const renameMissing = yield* service
        .renameNotebook(NotebookId.make("svc-missing"), "Nope")
        .pipe(Effect.flip);
      assert.strictEqual(renameMissing._tag, "NotebookNotFoundError");
    }),
  );

  it.effect("resolves a thread's notebook through links, falling back to the default", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const projectId = ProjectId.make("svc-thread");
      const threadId = ThreadId.make("svc-thread-1");

      const fallback = yield* service.notebookForThread(threadId, projectId);
      assert.isTrue(fallback.isDefault);

      const linked = yield* service.createNotebook({ projectId, title: "Linked" });
      const link = yield* service.linkThread(threadId, linked.notebookId);
      assert.strictEqual(link.notebookId, linked.notebookId);
      assert.strictEqual(link.threadId, threadId);
      const resolved = yield* service.notebookForThread(threadId, projectId);
      assert.strictEqual(resolved.notebookId, linked.notebookId);

      yield* service.unlinkThread(threadId);
      const afterUnlink = yield* service.notebookForThread(threadId, projectId);
      assert.strictEqual(afterUnlink.notebookId, fallback.notebookId);

      const missingTarget = yield* service
        .linkThread(threadId, NotebookId.make("svc-missing-target"))
        .pipe(Effect.flip);
      assert.strictEqual(missingTarget._tag, "NotebookNotFoundError");
    }),
  );
});

it.layer(TestLayer)("NotesService notes", (it) => {
  it.effect("creates, patches and deletes notes while touching the notebook", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const notebook = yield* service.defaultNotebook(ProjectId.make("svc-notes"));
      const created = yield* service.createNote({
        notebookId: notebook.notebookId,
        title: "Draft",
        body: "first body",
        author: { _tag: "user" },
      });
      assert.isFalse(created.pinned);
      assert.strictEqual(created.notebookId, notebook.notebookId);

      yield* TestClock.adjust("1 minute");
      const pinned = yield* service.updateNote(created.noteId, { pinned: true });
      assert.strictEqual(pinned.title, "Draft");
      assert.strictEqual(pinned.body, "first body");
      assert.isTrue(pinned.pinned);
      assert.strictEqual(pinned.createdAt, created.createdAt);
      assert.notStrictEqual(pinned.updatedAt, created.updatedAt);

      const rebodied = yield* service.updateNote(created.noteId, { body: "second body" });
      assert.strictEqual(rebodied.body, "second body");
      assert.isTrue(rebodied.pinned);
      assert.strictEqual((yield* service.getNote(created.noteId)).body, "second body");

      const touched = yield* service.getNotebook(notebook.notebookId);
      assert.notStrictEqual(touched.updatedAt, notebook.updatedAt);

      yield* service.deleteNote(created.noteId);
      const missing = yield* service.getNote(created.noteId).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "NoteNotFoundError");
      assert.strictEqual((yield* service.listNotes(notebook.notebookId)).length, 0);
    }),
  );

  it.effect("orders pinned notes first and newest after", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const notebook = yield* service.defaultNotebook(ProjectId.make("svc-order"));
      const threadId = ThreadId.make("svc-order-thread");
      const author = { _tag: "user" } as const;

      const older = yield* service.createNote({
        notebookId: notebook.notebookId,
        title: "older",
        body: "",
        author,
      });
      yield* TestClock.adjust("1 minute");
      const newer = yield* service.createNote({
        notebookId: notebook.notebookId,
        title: "newer",
        body: "",
        author: { _tag: "thread", threadId },
      });
      yield* TestClock.adjust("1 minute");
      const pinned = yield* service.createNote({
        notebookId: notebook.notebookId,
        title: "pinned",
        body: "",
        author,
        pinned: true,
      });

      const listed = yield* service.listNotes(notebook.notebookId);
      assert.deepStrictEqual(
        listed.map((entry) => entry.noteId),
        [pinned.noteId, newer.noteId, older.noteId],
      );
      assert.deepStrictEqual(listed[1]?.author, { _tag: "thread", threadId });
    }),
  );

  it.effect("rejects notes for unknown notebooks and patches for unknown notes", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const orphan = yield* service
        .createNote({
          notebookId: NotebookId.make("svc-missing-notebook"),
          title: "orphan",
          body: "",
          author: { _tag: "user" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(orphan._tag, "NotebookNotFoundError");

      const missingNote = yield* service
        .updateNote(NoteId.make("svc-missing-note"), { title: "renamed" })
        .pipe(Effect.flip);
      assert.strictEqual(missingNote._tag, "NoteNotFoundError");
      const deleteMissing = yield* service
        .deleteNote(NoteId.make("svc-missing-note"))
        .pipe(Effect.flip);
      assert.strictEqual(deleteMissing._tag, "NoteNotFoundError");

      const missingList = yield* service
        .listNotes(NotebookId.make("svc-missing-notebook"))
        .pipe(Effect.flip);
      assert.strictEqual(missingList._tag, "NotebookNotFoundError");
    }),
  );

  it.effect("deleting a notebook removes its notes", () =>
    Effect.gen(function* () {
      const service = yield* Service.NotesService;
      const notebook = yield* service.createNotebook({
        projectId: ProjectId.make("svc-cascade"),
        title: "Temporary",
      });
      const created = yield* service.createNote({
        notebookId: notebook.notebookId,
        title: "gone",
        body: "",
        author: { _tag: "user" },
      });

      yield* service.deleteNotebook(notebook.notebookId);

      const missing = yield* service.getNote(created.noteId).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "NoteNotFoundError");
    }),
  );
});
