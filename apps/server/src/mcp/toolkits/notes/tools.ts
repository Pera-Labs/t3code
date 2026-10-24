// fork: notes. MCP tools over the notebooks that the Notes right panel shows.
import {
  IsoDateTime,
  NonNegativeInt,
  Note,
  NoteAuthor,
  NoteBody,
  NoteId,
  NoteTitle,
  Notebook,
  NotebookId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as NotesService from "@t3tools/vision-notes/service";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Notes need no capability: a thread reads and writes the notebooks of its own
 * project, an approved MCP client those of the environment. A read-only client
 * is refused at the write tool, as everywhere else.
 */
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    NotesService.NotesService,
  ],
};

const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const NoteSummary = Schema.Struct({
  noteId: NoteId,
  title: NoteTitle,
  author: NoteAuthor,
  pinned: Schema.Boolean,
  updatedAt: IsoDateTime,
  bodyPreview: Schema.String,
  bodyLength: NonNegativeInt,
});
export type NoteSummary = typeof NoteSummary.Type;

const NotebookListTool = Tool.make("t3_notebook_list", {
  ...shared,
  description:
    "List the notebooks of a project. Omit projectId inside a T3 thread to use its project. threadNotebookId is the notebook this thread's notes go to (its linked notebook, else the project default); it is null for a client that is not a thread.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: Schema.Struct({
    notebooks: Schema.Array(Notebook),
    threadNotebookId: Schema.NullOr(NotebookId),
  }),
})
  .annotate(Tool.Title, "List notebooks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const NoteListTool = Tool.make("t3_note_list", {
  ...shared,
  description:
    "List the notes of a notebook, pinned first then newest first, as the Notes panel shows them. Omit notebookId to use this thread's notebook. Each entry carries a short body preview; call t3_note_read for the full body.",
  parameters: Schema.Struct({
    notebookId: Schema.optional(NotebookId),
    projectId: Schema.optional(ProjectId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PageLimit),
  }),
  success: Schema.Struct({
    notebook: Notebook,
    notes: Schema.Array(NoteSummary),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Title, "List notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const NoteReadTool = Tool.make("t3_note_read", {
  ...shared,
  description: "Read one note with its full body.",
  parameters: Schema.Struct({ noteId: NoteId }),
  success: Note,
})
  .annotate(Tool.Title, "Read a note")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const NoteWriteTool = Tool.make("t3_note_write", {
  ...shared,
  description:
    "Create a note, or update one when noteId is given. Creating needs title and body and writes into this thread's notebook unless notebookId is given. Updating changes only the fields passed and cannot move a note between notebooks. A note written from a thread names that thread as its author; the user sees it in the Notes panel.",
  parameters: Schema.Struct({
    noteId: Schema.optional(NoteId),
    notebookId: Schema.optional(NotebookId),
    projectId: Schema.optional(ProjectId),
    title: Schema.optional(NoteTitle),
    body: Schema.optional(NoteBody),
    pinned: Schema.optional(Schema.Boolean),
  }),
  success: Note,
})
  .annotate(Tool.Title, "Write a note")
  .annotate(Tool.Destructive, true);

export const NotesToolkit = Toolkit.make(
  NotebookListTool,
  NoteListTool,
  NoteReadTool,
  NoteWriteTool,
);
