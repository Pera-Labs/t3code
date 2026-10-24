import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  NotebookId,
  NoteId,
  type Note,
  type Notebook,
  type NotebookCreateInput,
  type NotebookTitle,
  type NoteCreateInput,
  type NotePatch,
  type NoteThreadLink,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { NotebookNotFoundError, NoteNotFoundError, type NotesRepositoryError } from "./errors.ts";
import { NotebookRepository, NoteRepository } from "./repository.ts";

export const DEFAULT_NOTEBOOK_TITLE = "Notes";

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

export class NotesService extends Context.Service<
  NotesService,
  {
    readonly listNotebooks: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Notebook>, NotesRepositoryError>;
    readonly getNotebook: (
      notebookId: NotebookId,
    ) => Effect.Effect<Notebook, NotesRepositoryError | NotebookNotFoundError>;
    readonly createNotebook: (
      input: NotebookCreateInput,
    ) => Effect.Effect<Notebook, NotesRepositoryError>;
    readonly renameNotebook: (
      notebookId: NotebookId,
      title: NotebookTitle,
    ) => Effect.Effect<Notebook, NotesRepositoryError | NotebookNotFoundError>;
    readonly deleteNotebook: (
      notebookId: NotebookId,
    ) => Effect.Effect<void, NotesRepositoryError | NotebookNotFoundError>;
    readonly defaultNotebook: (
      projectId: ProjectId,
    ) => Effect.Effect<Notebook, NotesRepositoryError>;
    readonly notebookForThread: (
      threadId: ThreadId,
      projectId: ProjectId,
    ) => Effect.Effect<Notebook, NotesRepositoryError>;
    readonly linkThread: (
      threadId: ThreadId,
      notebookId: NotebookId,
    ) => Effect.Effect<NoteThreadLink, NotesRepositoryError | NotebookNotFoundError>;
    readonly unlinkThread: (threadId: ThreadId) => Effect.Effect<void, NotesRepositoryError>;
    readonly listNotes: (
      notebookId: NotebookId,
    ) => Effect.Effect<ReadonlyArray<Note>, NotesRepositoryError | NotebookNotFoundError>;
    readonly getNote: (
      noteId: NoteId,
    ) => Effect.Effect<Note, NotesRepositoryError | NoteNotFoundError>;
    readonly createNote: (
      input: NoteCreateInput,
    ) => Effect.Effect<Note, NotesRepositoryError | NotebookNotFoundError>;
    readonly updateNote: (
      noteId: NoteId,
      patch: NotePatch,
    ) => Effect.Effect<Note, NotesRepositoryError | NoteNotFoundError>;
    readonly deleteNote: (
      noteId: NoteId,
    ) => Effect.Effect<void, NotesRepositoryError | NoteNotFoundError>;
  }
>()("@t3tools/vision-notes/service/NotesService") {}

const make = Effect.gen(function* () {
  const notebooks = yield* NotebookRepository;
  const notes = yield* NoteRepository;
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

  const requireNotebook = Effect.fn("NotesService.requireNotebook")(function* (
    notebookId: NotebookId,
  ) {
    const found = yield* notebooks.get(notebookId);
    if (Option.isNone(found)) {
      return yield* new NotebookNotFoundError({ notebookId });
    }
    return found.value;
  });

  const requireNote = Effect.fn("NotesService.requireNote")(function* (noteId: NoteId) {
    const found = yield* notes.get(noteId);
    if (Option.isNone(found)) {
      return yield* new NoteNotFoundError({ noteId });
    }
    return found.value;
  });

  const touchNotebook = Effect.fn("NotesService.touchNotebook")(function* (
    notebookId: NotebookId,
    updatedAt: string,
  ) {
    const notebook = yield* notebooks.get(notebookId);
    if (Option.isSome(notebook)) {
      yield* notebooks.put({ ...notebook.value, updatedAt });
    }
  });

  const createNotebook = Effect.fn("NotesService.createNotebook")(function* (
    input: NotebookCreateInput,
  ) {
    const notebookId = NotebookId.make(yield* newId);
    const now = yield* nowIso;
    const notebook: Notebook = {
      notebookId,
      projectId: input.projectId,
      title: input.title,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    yield* notebooks.put(notebook);
    return notebook;
  });

  const defaultNotebook = Effect.fn("NotesService.defaultNotebook")(function* (
    projectId: ProjectId,
  ) {
    const existing = yield* notebooks.getDefault(projectId);
    if (Option.isSome(existing)) {
      return existing.value;
    }
    const notebookId = NotebookId.make(yield* newId);
    const now = yield* nowIso;
    const notebook: Notebook = {
      notebookId,
      projectId,
      title: DEFAULT_NOTEBOOK_TITLE,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };
    return yield* notebooks.put(notebook).pipe(
      Effect.as(notebook),
      // A concurrent caller may have created the default first; the unique index rejects ours.
      Effect.catchTags({
        NotesSqlError: (error) =>
          notebooks
            .getDefault(projectId)
            .pipe(
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(error), onSome: Effect.succeed }),
              ),
            ),
      }),
    );
  });

  const notebookForThread = Effect.fn("NotesService.notebookForThread")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    const link = yield* notebooks.getThreadLink(threadId);
    if (Option.isSome(link)) {
      const linked = yield* notebooks.get(link.value.notebookId);
      if (Option.isSome(linked)) {
        return linked.value;
      }
    }
    return yield* defaultNotebook(projectId);
  });

  const linkThread = Effect.fn("NotesService.linkThread")(function* (
    threadId: ThreadId,
    notebookId: NotebookId,
  ) {
    yield* requireNotebook(notebookId);
    const link: NoteThreadLink = { threadId, notebookId, updatedAt: yield* nowIso };
    yield* notebooks.putThreadLink(link);
    return link;
  });

  const renameNotebook = Effect.fn("NotesService.renameNotebook")(function* (
    notebookId: NotebookId,
    title: NotebookTitle,
  ) {
    const current = yield* requireNotebook(notebookId);
    const updated: Notebook = { ...current, title, updatedAt: yield* nowIso };
    yield* notebooks.put(updated);
    return updated;
  });

  const deleteNotebook = Effect.fn("NotesService.deleteNotebook")(function* (
    notebookId: NotebookId,
  ) {
    yield* requireNotebook(notebookId);
    yield* notebooks.remove(notebookId);
  });

  const listNotes = Effect.fn("NotesService.listNotes")(function* (notebookId: NotebookId) {
    yield* requireNotebook(notebookId);
    return yield* notes.listByNotebook(notebookId);
  });

  const createNote = Effect.fn("NotesService.createNote")(function* (input: NoteCreateInput) {
    yield* requireNotebook(input.notebookId);
    const noteId = NoteId.make(yield* newId);
    const now = yield* nowIso;
    const note: Note = {
      noteId,
      notebookId: input.notebookId,
      title: input.title,
      body: input.body,
      author: input.author,
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    };
    yield* notes.put(note);
    yield* touchNotebook(input.notebookId, now);
    return note;
  });

  const updateNote = Effect.fn("NotesService.updateNote")(function* (
    noteId: NoteId,
    patch: NotePatch,
  ) {
    const current = yield* requireNote(noteId);
    const now = yield* nowIso;
    const updated: Note = {
      ...current,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      pinned: patch.pinned ?? current.pinned,
      updatedAt: now,
    };
    yield* notes.put(updated);
    yield* touchNotebook(current.notebookId, now);
    return updated;
  });

  const deleteNote = Effect.fn("NotesService.deleteNote")(function* (noteId: NoteId) {
    const current = yield* requireNote(noteId);
    yield* notes.remove(noteId);
    yield* touchNotebook(current.notebookId, yield* nowIso);
  });

  return NotesService.of({
    listNotebooks: (projectId) => notebooks.listByProject(projectId),
    getNotebook: requireNotebook,
    createNotebook,
    renameNotebook,
    deleteNotebook,
    defaultNotebook,
    notebookForThread,
    linkThread,
    unlinkThread: (threadId) => notebooks.removeThreadLink(threadId),
    listNotes,
    getNote: requireNote,
    createNote,
    updateNote,
    deleteNote,
  });
});

export const layer: Layer.Layer<
  NotesService,
  never,
  NotebookRepository | NoteRepository | Crypto.Crypto
> = Layer.effect(NotesService, make);
