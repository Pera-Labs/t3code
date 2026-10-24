// fork: notes. Handlers for the notes MCP toolkit.
import {
  type Note,
  type NoteAuthor,
  type NotePatch,
  type Notebook,
  type NotebookId,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import type * as NotesErrors from "@t3tools/vision-notes/errors";
import * as NotesService from "@t3tools/vision-notes/service";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { type Caller, loadCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { type NoteSummary, NotesToolkit } from "./tools.ts";

const DEFAULT_LIMIT = 50;
const PREVIEW_LENGTH = 200;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Storage failures carry no detail to the caller, like other orchestration errors. */
const notesFailure = (error: NotesErrors.NotesServiceError): OrchestratorMcpFailure =>
  error._tag === "NotebookNotFoundError" || error._tag === "NoteNotFoundError"
    ? invalid(error.message)
    : unavailable();

const summarize = (note: Note): NoteSummary => ({
  noteId: note.noteId,
  title: note.title,
  author: note.author,
  pinned: note.pinned,
  updatedAt: note.updatedAt,
  bodyPreview: note.body.slice(0, PREVIEW_LENGTH),
  bodyLength: note.body.length,
});

const authorOf = (caller: Caller): NoteAuthor =>
  caller.caller === undefined ? { _tag: "user" } : { _tag: "thread", threadId: caller.caller.id };

/**
 * A thread stays inside its own project; a client that is not a thread sees
 * every project of the environment, but a projectId it passes must match.
 */
const assertNotebookVisible = (
  caller: Caller,
  requested: ProjectId | undefined,
  notebook: Notebook,
) => {
  const thread = caller.caller;
  if (thread !== undefined && notebook.projectId !== thread.projectId) {
    return Effect.fail(invalid(`Notebook ${notebook.notebookId} belongs to another project.`));
  }
  if (requested !== undefined && notebook.projectId !== requested) {
    return Effect.fail(invalid(`Notebook ${notebook.notebookId} is not in project ${requested}.`));
  }
  return Effect.void;
};

/** The project a caller means: the one it passes, else its thread's. A thread cannot name another. */
const resolveVisibleProjectId = Effect.fn("mcp.notes.resolveVisibleProjectId")(function* (
  caller: Caller,
  requested: ProjectId | undefined,
) {
  const projectId = yield* resolveProjectId(caller, requested);
  if (caller.caller !== undefined && caller.caller.projectId !== projectId) {
    return yield* invalid("A thread can only use the notebooks of its own project.");
  }
  return projectId;
});

const resolveNotebook = Effect.fn("mcp.notes.resolveNotebook")(function* (
  caller: Caller,
  input: {
    readonly notebookId?: NotebookId | undefined;
    readonly projectId?: ProjectId | undefined;
  },
) {
  const notes = yield* NotesService.NotesService;
  if (input.notebookId !== undefined) {
    const notebook = yield* notes.getNotebook(input.notebookId).pipe(Effect.mapError(notesFailure));
    yield* assertNotebookVisible(caller, input.projectId, notebook);
    return notebook;
  }
  const projectId = yield* resolveVisibleProjectId(caller, input.projectId);
  const thread = caller.caller;
  return thread === undefined
    ? yield* notes.defaultNotebook(projectId).pipe(Effect.mapError(notesFailure))
    : yield* notes.notebookForThread(thread.id, projectId).pipe(Effect.mapError(notesFailure));
});

const readNoteVisible = Effect.fn("mcp.notes.readNoteVisible")(function* (
  caller: Caller,
  noteId: Note["noteId"],
  requested: ProjectId | undefined,
) {
  const notes = yield* NotesService.NotesService;
  const note = yield* notes.getNote(noteId).pipe(Effect.mapError(notesFailure));
  const notebook = yield* notes.getNotebook(note.notebookId).pipe(Effect.mapError(notesFailure));
  yield* assertNotebookVisible(caller, requested, notebook);
  return note;
});

export const layer = McpToolAccess.toLayer(NotesToolkit, {
  t3_notebook_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const notes = yield* NotesService.NotesService;
      const projectId = yield* resolveVisibleProjectId(caller, input.projectId);
      // Resolve the thread's notebook first: it creates the project default when none exists yet.
      const thread = caller.caller;
      const threadNotebook =
        thread === undefined
          ? null
          : yield* notes
              .notebookForThread(thread.id, projectId)
              .pipe(Effect.mapError(notesFailure));
      const notebooks = yield* notes.listNotebooks(projectId).pipe(Effect.mapError(notesFailure));
      return { notebooks, threadNotebookId: threadNotebook?.notebookId ?? null };
    }),
  ),
  t3_note_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const notes = yield* NotesService.NotesService;
      const notebook = yield* resolveNotebook(caller, input);
      const rows = yield* notes.listNotes(notebook.notebookId).pipe(Effect.mapError(notesFailure));
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? DEFAULT_LIMIT);
      return {
        notebook,
        notes: rows.slice(start, end).map(summarize),
        nextCursor: end < rows.length ? end : null,
      };
    }),
  ),
  t3_note_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      return yield* readNoteVisible(caller, input.noteId, undefined);
    }),
  ),
  t3_note_write: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const notes = yield* NotesService.NotesService;
      if (input.noteId === undefined) {
        if (input.title === undefined || input.body === undefined) {
          return yield* invalid("Pass title and body to create a note, or noteId to update one.");
        }
        const notebook = yield* resolveNotebook(caller, input);
        return yield* notes
          .createNote({
            notebookId: notebook.notebookId,
            title: input.title,
            body: input.body,
            author: authorOf(caller),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          })
          .pipe(Effect.mapError(notesFailure));
      }
      if (input.title === undefined && input.body === undefined && input.pinned === undefined) {
        return yield* invalid("Pass at least one of title, body, or pinned to update a note.");
      }
      const existing = yield* readNoteVisible(caller, input.noteId, input.projectId);
      if (input.notebookId !== undefined && input.notebookId !== existing.notebookId) {
        return yield* invalid("A note cannot move to another notebook.");
      }
      const patch: NotePatch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      };
      return yield* notes.updateNote(existing.noteId, patch).pipe(Effect.mapError(notesFailure));
    }),
  ),
});
