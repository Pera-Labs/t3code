import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  NoteAuthor,
  NotebookId,
  NoteId,
  NoteThreadLink,
  ProjectId,
  ThreadId,
  type Note,
  type Notebook,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { NotesDecodeError, NotesSqlError, type NotesRepositoryError } from "./errors.ts";

const NotebookRow = Schema.Struct({
  notebookId: NotebookId,
  projectId: ProjectId,
  title: Schema.String,
  isDefault: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const toNotebook = (row: typeof NotebookRow.Type): Notebook => ({
  ...row,
  isDefault: row.isDefault === 1,
});

const NoteRow = Schema.Struct({
  noteId: NoteId,
  notebookId: NotebookId,
  title: Schema.String,
  body: Schema.String,
  author: Schema.fromJsonString(NoteAuthor),
  pinned: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const toNote = (row: typeof NoteRow.Type): Note => ({
  ...row,
  pinned: row.pinned === 1,
});

const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(NoteAuthor));

const mapRepositoryError =
  (operation: string) =>
  (cause: unknown): NotesRepositoryError =>
    Schema.isSchemaError(cause)
      ? NotesDecodeError.fromSchemaError(operation, cause)
      : new NotesSqlError({ operation, cause });

export class NotebookRepository extends Context.Service<
  NotebookRepository,
  {
    readonly listByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Notebook>, NotesRepositoryError>;
    readonly get: (
      notebookId: NotebookId,
    ) => Effect.Effect<Option.Option<Notebook>, NotesRepositoryError>;
    readonly getDefault: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<Notebook>, NotesRepositoryError>;
    readonly put: (notebook: Notebook) => Effect.Effect<void, NotesRepositoryError>;
    readonly remove: (notebookId: NotebookId) => Effect.Effect<void, NotesRepositoryError>;
    readonly getThreadLink: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<NoteThreadLink>, NotesRepositoryError>;
    readonly putThreadLink: (link: NoteThreadLink) => Effect.Effect<void, NotesRepositoryError>;
    readonly removeThreadLink: (threadId: ThreadId) => Effect.Effect<void, NotesRepositoryError>;
  }
>()("@t3tools/vision-notes/repository/NotebookRepository") {}

export class NoteRepository extends Context.Service<
  NoteRepository,
  {
    readonly listByNotebook: (
      notebookId: NotebookId,
    ) => Effect.Effect<ReadonlyArray<Note>, NotesRepositoryError>;
    readonly get: (noteId: NoteId) => Effect.Effect<Option.Option<Note>, NotesRepositoryError>;
    readonly put: (note: Note) => Effect.Effect<void, NotesRepositoryError>;
    readonly remove: (noteId: NoteId) => Effect.Effect<void, NotesRepositoryError>;
  }
>()("@t3tools/vision-notes/repository/NoteRepository") {}

const makeNotebookRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByProject = SqlSchema.findAll({
    Request: ProjectId,
    Result: NotebookRow,
    execute: (projectId) => sql`
      SELECT notebook_id AS "notebookId",
             project_id AS "projectId",
             title,
             is_default AS "isDefault",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM notebooks
      WHERE project_id = ${projectId}
      ORDER BY is_default DESC, updated_at DESC, notebook_id ASC
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: NotebookId,
    Result: NotebookRow,
    execute: (notebookId) => sql`
      SELECT notebook_id AS "notebookId",
             project_id AS "projectId",
             title,
             is_default AS "isDefault",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM notebooks
      WHERE notebook_id = ${notebookId}
    `,
  });

  const findDefault = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: NotebookRow,
    execute: (projectId) => sql`
      SELECT notebook_id AS "notebookId",
             project_id AS "projectId",
             title,
             is_default AS "isDefault",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM notebooks
      WHERE project_id = ${projectId} AND is_default = 1
    `,
  });

  const findThreadLink = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: NoteThreadLink,
    execute: (threadId) => sql`
      SELECT thread_id AS "threadId",
             notebook_id AS "notebookId",
             updated_at AS "updatedAt"
      FROM note_thread_links
      WHERE thread_id = ${threadId}
    `,
  });

  return NotebookRepository.of({
    listByProject: (projectId) =>
      findByProject(projectId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.map(toNotebook)),
        Effect.mapError(mapRepositoryError("listNotebooks")),
      ),
    get: (notebookId) =>
      findById(notebookId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map(toNotebook)),
        Effect.mapError(mapRepositoryError("getNotebook")),
      ),
    getDefault: (projectId) =>
      findDefault(projectId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map(toNotebook)),
        Effect.mapError(mapRepositoryError("getDefaultNotebook")),
      ),
    put: (notebook) =>
      sql`
        INSERT INTO notebooks (notebook_id, project_id, title, is_default, created_at, updated_at)
        VALUES (
          ${notebook.notebookId},
          ${notebook.projectId},
          ${notebook.title},
          ${notebook.isDefault ? 1 : 0},
          ${notebook.createdAt},
          ${notebook.updatedAt}
        )
        ON CONFLICT (notebook_id) DO UPDATE SET
          title = excluded.title,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(mapRepositoryError("putNotebook"))),
    remove: (notebookId) =>
      sql`DELETE FROM notebooks WHERE notebook_id = ${notebookId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapRepositoryError("removeNotebook")),
      ),
    getThreadLink: (threadId) =>
      findThreadLink(threadId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(mapRepositoryError("getThreadLink")),
      ),
    putThreadLink: (link) =>
      sql`
        INSERT INTO note_thread_links (thread_id, notebook_id, updated_at)
        VALUES (${link.threadId}, ${link.notebookId}, ${link.updatedAt})
        ON CONFLICT (thread_id) DO UPDATE SET
          notebook_id = excluded.notebook_id,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(mapRepositoryError("putThreadLink"))),
    removeThreadLink: (threadId) =>
      sql`DELETE FROM note_thread_links WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapRepositoryError("removeThreadLink")),
      ),
  });
});

const makeNoteRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByNotebook = SqlSchema.findAll({
    Request: NotebookId,
    Result: NoteRow,
    execute: (notebookId) => sql`
      SELECT note_id AS "noteId",
             notebook_id AS "notebookId",
             title,
             body,
             author_json AS "author",
             pinned,
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM notes
      WHERE notebook_id = ${notebookId}
      ORDER BY pinned DESC, updated_at DESC, note_id ASC
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: NoteId,
    Result: NoteRow,
    execute: (noteId) => sql`
      SELECT note_id AS "noteId",
             notebook_id AS "notebookId",
             title,
             body,
             author_json AS "author",
             pinned,
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM notes
      WHERE note_id = ${noteId}
    `,
  });

  const put = Effect.fn("NoteRepository.put")(
    function* (note: Note) {
      const authorJson = yield* encodeAuthor(note.author);
      yield* sql`
        INSERT INTO notes (note_id, notebook_id, title, body, author_json, pinned, created_at, updated_at)
        VALUES (
          ${note.noteId},
          ${note.notebookId},
          ${note.title},
          ${note.body},
          ${authorJson},
          ${note.pinned ? 1 : 0},
          ${note.createdAt},
          ${note.updatedAt}
        )
        ON CONFLICT (note_id) DO UPDATE SET
          notebook_id = excluded.notebook_id,
          title = excluded.title,
          body = excluded.body,
          author_json = excluded.author_json,
          pinned = excluded.pinned,
          updated_at = excluded.updated_at
      `;
    },
    Effect.mapError(mapRepositoryError("putNote")),
  );

  return NoteRepository.of({
    listByNotebook: (notebookId) =>
      findByNotebook(notebookId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows.map(toNote)),
        Effect.mapError(mapRepositoryError("listNotes")),
      ),
    get: (noteId) =>
      findById(noteId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map(toNote)),
        Effect.mapError(mapRepositoryError("getNote")),
      ),
    put,
    remove: (noteId) =>
      sql`DELETE FROM notes WHERE note_id = ${noteId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapRepositoryError("removeNote")),
      ),
  });
});

export const layerNotebooks: Layer.Layer<NotebookRepository, never, SqlClient.SqlClient> =
  Layer.effect(NotebookRepository, makeNotebookRepository);

export const layerNotes: Layer.Layer<NoteRepository, never, SqlClient.SqlClient> = Layer.effect(
  NoteRepository,
  makeNoteRepository,
);

export const layer: Layer.Layer<NotebookRepository | NoteRepository, never, SqlClient.SqlClient> =
  Layer.mergeAll(layerNotebooks, layerNotes);
