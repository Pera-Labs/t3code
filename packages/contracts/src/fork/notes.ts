import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const NOTEBOOK_TITLE_MAX_LENGTH = 200;
export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_BODY_MAX_LENGTH = 65_536;

export const NotebookId = TrimmedNonEmptyString.pipe(Schema.brand<"NotebookId">("NotebookId"));
export type NotebookId = typeof NotebookId.Type;
export const NoteId = TrimmedNonEmptyString.pipe(Schema.brand<"NoteId">("NoteId"));
export type NoteId = typeof NoteId.Type;

export const NotebookTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(NOTEBOOK_TITLE_MAX_LENGTH),
);
export type NotebookTitle = typeof NotebookTitle.Type;
export const NoteTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH));
export type NoteTitle = typeof NoteTitle.Type;
export const NoteBody = Schema.String.check(Schema.isMaxLength(NOTE_BODY_MAX_LENGTH));
export type NoteBody = typeof NoteBody.Type;

export const NoteAuthor = Schema.Union([
  Schema.TaggedStruct("user", {}),
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
]);
export type NoteAuthor = typeof NoteAuthor.Type;

export const Notebook = Schema.Struct({
  notebookId: NotebookId,
  projectId: ProjectId,
  title: NotebookTitle,
  isDefault: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Notebook = typeof Notebook.Type;

export const Note = Schema.Struct({
  noteId: NoteId,
  notebookId: NotebookId,
  title: NoteTitle,
  body: NoteBody,
  author: NoteAuthor,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Note = typeof Note.Type;

export const NoteThreadLink = Schema.Struct({
  threadId: ThreadId,
  notebookId: NotebookId,
  updatedAt: IsoDateTime,
});
export type NoteThreadLink = typeof NoteThreadLink.Type;

export const NotebookCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: NotebookTitle,
});
export type NotebookCreateInput = typeof NotebookCreateInput.Type;

export const NoteCreateInput = Schema.Struct({
  notebookId: NotebookId,
  title: NoteTitle,
  body: NoteBody,
  author: NoteAuthor,
  pinned: Schema.optionalKey(Schema.Boolean),
});
export type NoteCreateInput = typeof NoteCreateInput.Type;

export const NotePatch = Schema.Struct({
  title: Schema.optionalKey(NoteTitle),
  body: Schema.optionalKey(NoteBody),
  pinned: Schema.optionalKey(Schema.Boolean),
});
export type NotePatch = typeof NotePatch.Type;
