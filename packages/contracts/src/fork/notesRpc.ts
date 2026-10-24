import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import {
  Note,
  Notebook,
  NotebookCreateInput,
  NotebookId,
  NotebookNotFoundError,
  NotebookTitle,
  NoteCreateInput,
  NoteId,
  NoteNotFoundError,
  NotePatch,
  NoteThreadLink,
} from "./notes.ts";

/** WebSocket RPC method names for the fork-only notes feature; spread into WS_METHODS. */
export const NOTES_WS_METHODS = {
  notesListNotebooks: "notes.listNotebooks",
  notesGetNotebook: "notes.getNotebook",
  notesCreateNotebook: "notes.createNotebook",
  notesRenameNotebook: "notes.renameNotebook",
  notesDeleteNotebook: "notes.deleteNotebook",
  notesDefaultNotebook: "notes.defaultNotebook",
  notesNotebookForThread: "notes.notebookForThread",
  notesLinkThread: "notes.linkThread",
  notesUnlinkThread: "notes.unlinkThread",
  notesListNotes: "notes.listNotes",
  notesGetNote: "notes.getNote",
  notesCreateNote: "notes.createNote",
  notesUpdateNote: "notes.updateNote",
  notesDeleteNote: "notes.deleteNote",
} as const;

export class NotesStorageError extends Schema.TaggedError<NotesStorageError>()(
  "NotesStorageError",
  {
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `notes storage failed in ${this.operation}: ${this.detail}`;
  }
}

export const NotesListNotebooksInput = Schema.Struct({ projectId: ProjectId });
export type NotesListNotebooksInput = typeof NotesListNotebooksInput.Type;
export const NotesNotebookRefInput = Schema.Struct({ notebookId: NotebookId });
export type NotesNotebookRefInput = typeof NotesNotebookRefInput.Type;
export const NotesRenameNotebookInput = Schema.Struct({
  notebookId: NotebookId,
  title: NotebookTitle,
});
export type NotesRenameNotebookInput = typeof NotesRenameNotebookInput.Type;
export const NotesThreadRefInput = Schema.Struct({ threadId: ThreadId });
export type NotesThreadRefInput = typeof NotesThreadRefInput.Type;
export const NotesNotebookForThreadInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type NotesNotebookForThreadInput = typeof NotesNotebookForThreadInput.Type;
export const NotesLinkThreadInput = Schema.Struct({ threadId: ThreadId, notebookId: NotebookId });
export type NotesLinkThreadInput = typeof NotesLinkThreadInput.Type;
export const NotesNoteRefInput = Schema.Struct({ noteId: NoteId });
export type NotesNoteRefInput = typeof NotesNoteRefInput.Type;
export const NotesUpdateNoteInput = Schema.Struct({ noteId: NoteId, patch: NotePatch });
export type NotesUpdateNoteInput = typeof NotesUpdateNoteInput.Type;

const NotesStorageErrors = Schema.Union([NotesStorageError, EnvironmentAuthorizationError]);
const NotesNotebookErrors = Schema.Union([
  NotesStorageError,
  NotebookNotFoundError,
  EnvironmentAuthorizationError,
]);
const NotesNoteErrors = Schema.Union([
  NotesStorageError,
  NoteNotFoundError,
  EnvironmentAuthorizationError,
]);

export const WsNotesListNotebooksRpc = Rpc.make(NOTES_WS_METHODS.notesListNotebooks, {
  payload: NotesListNotebooksInput,
  success: Schema.Array(Notebook),
  error: NotesStorageErrors,
});
export const WsNotesGetNotebookRpc = Rpc.make(NOTES_WS_METHODS.notesGetNotebook, {
  payload: NotesNotebookRefInput,
  success: Notebook,
  error: NotesNotebookErrors,
});
export const WsNotesCreateNotebookRpc = Rpc.make(NOTES_WS_METHODS.notesCreateNotebook, {
  payload: NotebookCreateInput,
  success: Notebook,
  error: NotesStorageErrors,
});
export const WsNotesRenameNotebookRpc = Rpc.make(NOTES_WS_METHODS.notesRenameNotebook, {
  payload: NotesRenameNotebookInput,
  success: Notebook,
  error: NotesNotebookErrors,
});
export const WsNotesDeleteNotebookRpc = Rpc.make(NOTES_WS_METHODS.notesDeleteNotebook, {
  payload: NotesNotebookRefInput,
  success: Schema.Void,
  error: NotesNotebookErrors,
});
export const WsNotesDefaultNotebookRpc = Rpc.make(NOTES_WS_METHODS.notesDefaultNotebook, {
  payload: NotesListNotebooksInput,
  success: Notebook,
  error: NotesStorageErrors,
});
export const WsNotesNotebookForThreadRpc = Rpc.make(NOTES_WS_METHODS.notesNotebookForThread, {
  payload: NotesNotebookForThreadInput,
  success: Notebook,
  error: NotesStorageErrors,
});
export const WsNotesLinkThreadRpc = Rpc.make(NOTES_WS_METHODS.notesLinkThread, {
  payload: NotesLinkThreadInput,
  success: NoteThreadLink,
  error: NotesNotebookErrors,
});
export const WsNotesUnlinkThreadRpc = Rpc.make(NOTES_WS_METHODS.notesUnlinkThread, {
  payload: NotesThreadRefInput,
  success: Schema.Void,
  error: NotesStorageErrors,
});
export const WsNotesListNotesRpc = Rpc.make(NOTES_WS_METHODS.notesListNotes, {
  payload: NotesNotebookRefInput,
  success: Schema.Array(Note),
  error: NotesNotebookErrors,
});
export const WsNotesGetNoteRpc = Rpc.make(NOTES_WS_METHODS.notesGetNote, {
  payload: NotesNoteRefInput,
  success: Note,
  error: NotesNoteErrors,
});
export const WsNotesCreateNoteRpc = Rpc.make(NOTES_WS_METHODS.notesCreateNote, {
  payload: NoteCreateInput,
  success: Note,
  error: NotesNotebookErrors,
});
export const WsNotesUpdateNoteRpc = Rpc.make(NOTES_WS_METHODS.notesUpdateNote, {
  payload: NotesUpdateNoteInput,
  success: Note,
  error: NotesNoteErrors,
});
export const WsNotesDeleteNoteRpc = Rpc.make(NOTES_WS_METHODS.notesDeleteNote, {
  payload: NotesNoteRefInput,
  success: Schema.Void,
  error: NotesNoteErrors,
});
