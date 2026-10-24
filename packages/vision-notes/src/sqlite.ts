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
export const T3_HOME_ENV = "T3CODE_HOME";

/** Notes keep their own file inside the T3 home so upstream schema changes never touch them. */
export const resolveDatabasePath: Effect.Effect<string, never, Path.Path> = Effect.gen(
  function* () {
    const env = yield* HostProcess.Environment;
    const path = yield* Path.Path;
    const override = env[DATABASE_PATH_ENV];
    if (override !== undefined && override !== "") {
      return override;
    }
    const explicitHome = env[T3_HOME_ENV];
    const t3Home =
      explicitHome !== undefined && explicitHome !== ""
        ? explicitHome
        : path.join(yield* HostProcess.HomeDirectory, ".t3");
    return path.join(t3Home, DATABASE_FILE);
  },
);

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

export const layerDefault = Layer.unwrap(
  Effect.gen(function* () {
    const dbPath = yield* resolveDatabasePath;
    return layerFromPath(dbPath);
  }),
);
