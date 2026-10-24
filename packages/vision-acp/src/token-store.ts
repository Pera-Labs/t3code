import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

export const STATE_DIR_ENV = "VISION_ACP_STATE_DIR";
export const T3_HOME_ENV = "T3CODE_HOME";
export const CREDENTIALS_FILE = "credentials.json";

export const StoredCredentials = Schema.Struct({
  mcpUrl: Schema.String,
  clientId: Schema.String,
  tokenEndpoint: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
  scope: Schema.String,
});
export type StoredCredentials = typeof StoredCredentials.Type;

const StoredCredentialsJson = Schema.fromJsonString(StoredCredentials);
const decodeStored = Schema.decodeUnknownEffect(StoredCredentialsJson);
const encodeStored = Schema.encodeEffect(StoredCredentialsJson);

export class TokenStoreError extends Schema.TaggedError<TokenStoreError>()("TokenStoreError", {
  operation: Schema.Literals(["load", "save", "clear"]),
  detail: Schema.String,
}) {
  override get message() {
    return `token store ${this.operation} failed: ${this.detail}`;
  }
}

export class TokenStore extends Context.Service<
  TokenStore,
  {
    readonly load: Effect.Effect<Option.Option<StoredCredentials>, TokenStoreError>;
    readonly save: (credentials: StoredCredentials) => Effect.Effect<void, TokenStoreError>;
    readonly clear: Effect.Effect<void, TokenStoreError>;
  }
>()("@t3tools/vision-acp/token-store/TokenStore") {}

export const resolveStateDir: Effect.Effect<string, never, Path.Path> = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const override = env[STATE_DIR_ENV];
  if (override !== undefined && override !== "") {
    return override;
  }
  const explicitHome = env[T3_HOME_ENV];
  const t3Home =
    explicitHome !== undefined && explicitHome !== ""
      ? explicitHome
      : path.join(yield* HostProcess.HomeDirectory, ".t3");
  return path.join(t3Home, "vision-acp");
});

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const layerFile: Layer.Layer<TokenStore, never, FileSystem.FileSystem | Path.Path> =
  Layer.effect(
    TokenStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* resolveStateDir;
      const filePath = path.join(stateDir, CREDENTIALS_FILE);

      const load = Effect.gen(function* () {
        const exists = yield* fs.exists(filePath);
        if (!exists) {
          return Option.none<StoredCredentials>();
        }
        const text = yield* fs.readFileString(filePath);
        return yield* decodeStored(text).pipe(
          Effect.asSome,
          // A corrupt or outdated file only means the owner has to log in again.
          Effect.catchTags({ SchemaError: () => Effect.succeedNone }),
        );
      }).pipe(
        Effect.mapError(
          (cause) => new TokenStoreError({ operation: "load", detail: describeFailure(cause) }),
        ),
      );

      const save = Effect.fn("TokenStore.save")(
        function* (credentials: StoredCredentials) {
          const json = yield* encodeStored(credentials);
          yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(filePath, json, { mode: 0o600 });
        },
        Effect.mapError(
          (cause) => new TokenStoreError({ operation: "save", detail: describeFailure(cause) }),
        ),
      );

      const clear = fs
        .remove(filePath, { force: true })
        .pipe(
          Effect.mapError(
            (cause) => new TokenStoreError({ operation: "clear", detail: describeFailure(cause) }),
          ),
        );

      return { load, save, clear };
    }),
  );

export const layerMemory: Layer.Layer<TokenStore> = Layer.effect(
  TokenStore,
  Effect.map(Ref.make(Option.none<StoredCredentials>()), (ref) => ({
    load: Ref.get(ref),
    save: (credentials: StoredCredentials) => Ref.set(ref, Option.some(credentials)),
    clear: Ref.set(ref, Option.none()),
  })),
);
