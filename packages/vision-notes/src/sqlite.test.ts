import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Repository from "./repository.ts";
import * as Service from "./service.ts";
import * as Sqlite from "./sqlite.ts";

const layerForPath = (dbPath: string) =>
  Service.layer.pipe(
    Layer.provideMerge(Repository.layer),
    Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
  );

it.layer(NodeServices.layer)("VisionNotes sqlite", (it) => {
  it.effect("persists notebooks and notes across reopening the same database file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vision-notes-" });
      const dbPath = path.join(dir, "nested", "notes.sqlite");
      const projectId = ProjectId.make("sqlite-persist");

      const created = yield* Effect.gen(function* () {
        const service = yield* Service.NotesService;
        const notebook = yield* service.defaultNotebook(projectId);
        yield* service.createNote({
          notebookId: notebook.notebookId,
          title: "kept",
          body: "on disk",
          author: { _tag: "user" },
        });
        return notebook;
      }).pipe(Effect.provide(layerForPath(dbPath)));

      const reopened = yield* Effect.gen(function* () {
        const service = yield* Service.NotesService;
        const notebook = yield* service.defaultNotebook(projectId);
        const notes = yield* service.listNotes(notebook.notebookId);
        return { notebook, notes };
      }).pipe(Effect.provide(layerForPath(dbPath)));

      assert.strictEqual(reopened.notebook.notebookId, created.notebookId);
      assert.strictEqual(reopened.notes.length, 1);
      assert.strictEqual(reopened.notes[0]?.body, "on disk");
      assert.isTrue(yield* fs.exists(dbPath));
    }).pipe(Effect.scoped),
  );

  it.effect("resolves the database path from the override, then the state directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const overridden = yield* Sqlite.resolveDatabasePath("/srv/t3/userdata").pipe(
        Effect.provideService(HostProcess.Environment, {
          [Sqlite.DATABASE_PATH_ENV]: "/data/override.sqlite",
        }),
      );
      assert.strictEqual(overridden, "/data/override.sqlite");

      const fromStateDir = yield* Sqlite.resolveDatabasePath("/srv/t3/userdata").pipe(
        Effect.provideService(HostProcess.Environment, { [Sqlite.DATABASE_PATH_ENV]: "" }),
      );
      assert.strictEqual(fromStateDir, path.join("/srv/t3/userdata", Sqlite.DATABASE_FILE));
    }),
  );
});
