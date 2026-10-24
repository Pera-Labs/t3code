import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./migrations/001_Notebooks.ts";

export const migrationEntries = [[1, "Notebooks", Migration0001]] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

export const runMigrations = Effect.fn("VisionNotes.runMigrations")(function* () {
  const executed = yield* run({ loader });
  if (executed.length > 0) {
    yield* Effect.log("Vision notes migrations ran").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
