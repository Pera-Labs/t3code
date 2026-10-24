import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import * as Repository from "./repository.ts";
import * as Service from "./service.ts";
import * as Sqlite from "./sqlite.ts";

/**
 * Notes service backed by the on-disk SQLite database in the server's state directory; the
 * path rules live in sqlite.ts. A database that cannot be opened or migrated is a defect, like
 * the main t3code database. Build it once per server and share the layer: every call opens
 * its own connection.
 */
export const layerForStateDir = (
  stateDir: string,
): Layer.Layer<Service.NotesService, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
  Service.layer.pipe(
    Layer.provide(Repository.layer),
    Layer.provide(Sqlite.layerForStateDir(stateDir)),
    Layer.orDie,
  );

/** In-memory variant for tests and headless smoke runs. */
export const layerMemory: Layer.Layer<Service.NotesService, never, Crypto.Crypto> =
  Service.layer.pipe(
    Layer.provide(Repository.layer),
    Layer.provide(Sqlite.layerMemory),
    Layer.orDie,
  );
