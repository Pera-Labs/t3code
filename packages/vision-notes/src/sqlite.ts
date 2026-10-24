import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./migrations.ts";

export const DATABASE_FILE = "fork-notes.sqlite";
export const DATABASE_PATH_ENV = "VISION_NOTES_DB_PATH";

/**
 * Notes keep their own file next to the server's main database, so upstream schema changes
 * never touch them and a dev server never shares notes with the packaged one. The env override
 * wins, for tests and operators.
 */
export const resolveDatabasePath = Effect.fn("VisionNotes.resolveDatabasePath")(function* (
  stateDir: string,
) {
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const override = env[DATABASE_PATH_ENV];
  if (override !== undefined && override !== "") {
    return override;
  }
  return path.join(stateDir, DATABASE_FILE);
});

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* runMigrations();
  }),
);

export const layerFromPath = Effect.fn("VisionNotes.layerFromPath")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      checkpointWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-vision-notes",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

/** On-disk database inside the given state directory (see resolveDatabasePath). */
export const layerForStateDir = Effect.fn("VisionNotes.layerForStateDir")(function* (
  stateDir: string,
) {
  const dbPath = yield* resolveDatabasePath(stateDir);
  return layerFromPath(dbPath);
}, Layer.unwrap);
