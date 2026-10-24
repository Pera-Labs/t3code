import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NotebookId,
  NoteId,
  ProjectId,
  ThreadId,
  type Note,
  type Notebook,
} from "@t3tools/contracts";

import * as Repository from "./repository.ts";
import * as Sqlite from "./sqlite.ts";

const TestLayer = Repository.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const iso = Schema.decodeUnknownSync(IsoDateTime);
const T0 = iso("2026-01-01T00:00:00.000Z");
const T1 = iso("2026-01-01T00:01:00.000Z");
const T2 = iso("2026-01-01T00:02:00.000Z");

const notebook = (
  id: string,
  projectId: ProjectId,
  overrides: Partial<Omit<Notebook, "notebookId" | "projectId">> = {},
): Notebook => ({
  notebookId: NotebookId.make(id),
  projectId,
  title: `Notebook ${id}`,
  isDefault: false,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const note = (
  id: string,
  notebookId: NotebookId,
  overrides: Partial<Omit<Note, "noteId" | "notebookId">> = {},
): Note => ({
  noteId: NoteId.make(id),
  notebookId,
  title: `Note ${id}`,
  body: "",
  author: { _tag: "user" },
  pinned: false,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const notebookIds = (entries: ReadonlyArray<Notebook>): ReadonlyArray<string> =>
  entries.map((entry) => entry.notebookId);

const noteIds = (entries: ReadonlyArray<Note>): ReadonlyArray<string> =>
  entries.map((entry) => entry.noteId);

it.layer(TestLayer)("NotebookRepository", (it) => {
  it.effect("lists the default notebook first, then the most recently updated", () =>
    Effect.gen(function* () {
      const repo = yield* Repository.NotebookRepository;
      const projectId = ProjectId.make("repo-list");
      yield* repo.put(notebook("list-a", projectId, { updatedAt: T1 }));
      yield* repo.put(notebook("list-b", projectId, { updatedAt: T2 }));
      yield* repo.put(notebook("list-default", projectId, { isDefault: true }));
      yield* repo.put(notebook("list-other", ProjectId.make("repo-list-other")));

      const listed = yield* repo.listByProject(projectId);
      assert.deepStrictEqual(notebookIds(listed), ["list-default", "list-b", "list-a"]);

      const fetched = yield* repo.get(NotebookId.make("list-default"));
      assert.isTrue(Option.getOrThrow(fetched).isDefault);

      const byDefault = yield* repo.getDefault(projectId);
      assert.strictEqual(Option.getOrThrow(byDefault).notebookId, "list-default");
      assert.isTrue(Option.isNone(yield* repo.getDefault(ProjectId.make("repo-list-other"))));
    }),
  );

  it.effect("rejects a second default notebook for the same project but allows upserts", () =>
    Effect.gen(function* () {
      const repo = yield* Repository.NotebookRepository;
      const projectId = ProjectId.make("repo-unique");
      yield* repo.put(notebook("unique-a", projectId, { isDefault: true }));

      const failure = yield* repo
        .put(notebook("unique-b", projectId, { isDefault: true }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "NotesSqlError");

      yield* repo.put(notebook("unique-a", projectId, { isDefault: true, title: "Renamed" }));
      const fetched = yield* repo.get(NotebookId.make("unique-a"));
      assert.strictEqual(Option.getOrThrow(fetched).title, "Renamed");
      assert.isTrue(Option.isNone(yield* repo.get(NotebookId.make("unique-b"))));
    }),
  );

  it.effect("removing a notebook cascades to its notes and thread links", () =>
    Effect.gen(function* () {
      const notebooks = yield* Repository.NotebookRepository;
      const notes = yield* Repository.NoteRepository;
      const notebookId = NotebookId.make("cascade");
      const threadId = ThreadId.make("thread-cascade");
      yield* notebooks.put(notebook("cascade", ProjectId.make("repo-cascade")));
      yield* notes.put(note("cascade-note", notebookId));
      yield* notebooks.putThreadLink({ threadId, notebookId, updatedAt: T0 });

      yield* notebooks.remove(notebookId);

      assert.isTrue(Option.isNone(yield* notebooks.get(notebookId)));
      assert.isTrue(Option.isNone(yield* notes.get(NoteId.make("cascade-note"))));
      assert.isTrue(Option.isNone(yield* notebooks.getThreadLink(threadId)));
    }),
  );

  it.effect("upserts thread links by thread id", () =>
    Effect.gen(function* () {
      const repo = yield* Repository.NotebookRepository;
      const projectId = ProjectId.make("repo-links");
      const threadId = ThreadId.make("thread-links");
      yield* repo.put(notebook("links-a", projectId));
      yield* repo.put(notebook("links-b", projectId));

      yield* repo.putThreadLink({
        threadId,
        notebookId: NotebookId.make("links-a"),
        updatedAt: T0,
      });
      yield* repo.putThreadLink({
        threadId,
        notebookId: NotebookId.make("links-b"),
        updatedAt: T1,
      });
      const link = yield* repo.getThreadLink(threadId);
      assert.strictEqual(Option.getOrThrow(link).notebookId, "links-b");
      assert.strictEqual(Option.getOrThrow(link).updatedAt, T1);

      yield* repo.removeThreadLink(threadId);
      assert.isTrue(Option.isNone(yield* repo.getThreadLink(threadId)));
      yield* repo.removeThreadLink(threadId);
    }),
  );
});

it.layer(TestLayer)("NoteRepository", (it) => {
  it.effect("round-trips the note author through json", () =>
    Effect.gen(function* () {
      const notebooks = yield* Repository.NotebookRepository;
      const notes = yield* Repository.NoteRepository;
      const notebookId = NotebookId.make("authors");
      const threadId = ThreadId.make("thread-author");
      yield* notebooks.put(notebook("authors", ProjectId.make("repo-authors")));
      yield* notes.put(note("by-user", notebookId));
      yield* notes.put(
        note("by-thread", notebookId, {
          author: { _tag: "thread", threadId },
          body: "from thread",
        }),
      );

      const byThread = Option.getOrThrow(yield* notes.get(NoteId.make("by-thread")));
      assert.deepStrictEqual(byThread.author, { _tag: "thread", threadId });
      assert.strictEqual(byThread.body, "from thread");
      const byUser = Option.getOrThrow(yield* notes.get(NoteId.make("by-user")));
      assert.deepStrictEqual(byUser.author, { _tag: "user" });
    }),
  );

  it.effect("lists pinned notes first, then the most recently updated", () =>
    Effect.gen(function* () {
      const notebooks = yield* Repository.NotebookRepository;
      const notes = yield* Repository.NoteRepository;
      const notebookId = NotebookId.make("ordering");
      yield* notebooks.put(notebook("ordering", ProjectId.make("repo-ordering")));
      yield* notes.put(note("order-old", notebookId, { updatedAt: T0 }));
      yield* notes.put(note("order-new", notebookId, { updatedAt: T2 }));
      yield* notes.put(note("order-pinned", notebookId, { pinned: true, updatedAt: T1 }));
      yield* notes.put(note("order-elsewhere", NotebookId.make("authors")));

      const listed = yield* notes.listByNotebook(notebookId);
      assert.deepStrictEqual(noteIds(listed), ["order-pinned", "order-new", "order-old"]);
      assert.isTrue(listed[0]?.pinned);
      assert.isFalse(listed[1]?.pinned);
    }),
  );

  it.effect("upserts and removes notes by id", () =>
    Effect.gen(function* () {
      const notebooks = yield* Repository.NotebookRepository;
      const notes = yield* Repository.NoteRepository;
      const notebookId = NotebookId.make("upserts");
      const noteId = NoteId.make("upsert-note");
      yield* notebooks.put(notebook("upserts", ProjectId.make("repo-upserts")));
      yield* notes.put(note("upsert-note", notebookId, { body: "v1" }));
      yield* notes.put(
        note("upsert-note", notebookId, { body: "v2", title: "Second", updatedAt: T1 }),
      );

      const fetched = Option.getOrThrow(yield* notes.get(noteId));
      assert.strictEqual(fetched.body, "v2");
      assert.strictEqual(fetched.title, "Second");
      assert.strictEqual(fetched.updatedAt, T1);
      assert.strictEqual((yield* notes.listByNotebook(notebookId)).length, 1);

      yield* notes.remove(noteId);
      assert.isTrue(Option.isNone(yield* notes.get(noteId)));
      yield* notes.remove(noteId);
    }),
  );

  it.effect("rejects notes whose notebook does not exist", () =>
    Effect.gen(function* () {
      const notes = yield* Repository.NoteRepository;
      const failure = yield* notes
        .put(note("orphan", NotebookId.make("missing-notebook")))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "NotesSqlError");
    }),
  );
});
