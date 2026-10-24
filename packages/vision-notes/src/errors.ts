import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { NotebookId, NoteId } from "@t3tools/contracts";

const summarizeIssue = (issue: SchemaIssue.Issue): string => {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return `${issue._tag}(${summarizeIssue(issue.issue)})`;
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeIssue).join(",")})`;
    default:
      return issue._tag;
  }
};

export class NotesSqlError extends Schema.TaggedError<NotesSqlError>()("NotesSqlError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : undefined;
    return detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${detail}`;
  }
}

export class NotesDecodeError extends Schema.TaggedError<NotesDecodeError>()("NotesDecodeError", {
  operation: Schema.String,
  issue: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  static fromSchemaError(operation: string, cause: Schema.SchemaError): NotesDecodeError {
    return new NotesDecodeError({ operation, issue: summarizeIssue(cause.issue), cause });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export class NotebookNotFoundError extends Schema.TaggedError<NotebookNotFoundError>()(
  "NotebookNotFoundError",
  { notebookId: NotebookId },
) {
  override get message(): string {
    return `notebook ${this.notebookId} not found`;
  }
}

export class NoteNotFoundError extends Schema.TaggedError<NoteNotFoundError>()(
  "NoteNotFoundError",
  { noteId: NoteId },
) {
  override get message(): string {
    return `note ${this.noteId} not found`;
  }
}

export type NotesRepositoryError = NotesSqlError | NotesDecodeError;
export type NotesServiceError = NotesRepositoryError | NotebookNotFoundError | NoteNotFoundError;
