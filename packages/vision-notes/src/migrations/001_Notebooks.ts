import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notebooks (
      notebook_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS notebooks_default_per_project
      ON notebooks (project_id)
      WHERE is_default = 1
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS notebooks_by_project
      ON notebooks (project_id, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS notes (
      note_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks (notebook_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS notes_by_notebook
      ON notes (notebook_id, pinned, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS note_thread_links (
      thread_id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES notebooks (notebook_id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
