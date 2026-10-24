// @effect-diagnostics nodeBuiltinImport:off - the loopback OAuth callback server needs Node's http.createServer
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as BrowserOpener from "./browser-opener.ts";
import * as Config from "./config.ts";
import * as Http from "./http.ts";
import * as TokenStore from "./token-store.ts";

export const AUTH_METHOD_ID = "owner-oauth";
export const SCOPE = "vision:chat";
export const CLIENT_NAME = "t3code vision-acp";

const CALLBACK_TIMEOUT = Duration.minutes(5);
const EARLY_REFRESH_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

const ProtectedResourceMetadata = Schema.Struct({
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
});

const AuthorizationServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
});

const RegistrationResponse = Schema.Struct({ client_id: Schema.String });

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
type TokenResponse = typeof TokenResponse.Type;

const OAuthErrorBody = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

const decodeProtectedResourceMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProtectedResourceMetadata),
);
const decodeAuthorizationServerMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthorizationServerMetadata),
);
const decodeRegistrationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RegistrationResponse),
);
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse));
const decodeOAuthErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthErrorBody));

export class OwnerAuthError extends Schema.TaggedError<OwnerAuthError>()("OwnerAuthError", {
  reason: Schema.Literals([
    "unavailable",
    "discovery",
    "registration",
    "callback",
    "timeout",
    "denied",
    "token",
    "store",
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return `Vision owner login ${this.reason}: ${this.detail}`;
  }
}

export interface OwnerAuthShape {
  /** Runs the browser login once and persists the resulting tokens. */
  readonly authenticate: Effect.Effect<void, OwnerAuthError>;
  /** Returns a usable access token, refreshing it when it is about to expire. */
  readonly currentAccessToken: Effect.Effect<Option.Option<string>, OwnerAuthError>;
  /** Forces a refresh after Vision rejected the current token. */
  readonly refreshAccessToken: Effect.Effect<Option.Option<string>, OwnerAuthError>;
  readonly logout: Effect.Effect<void, OwnerAuthError>;
}

export class OwnerAuth extends Context.Service<OwnerAuth, OwnerAuthShape>()(
  "@t3tools/vision-acp/oauth/OwnerAuth",
) {}

interface AuthorizationServer {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | undefined;
}

const COMPLETE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vision bridge connected</title></head>' +
  '<body style="font-family: system-ui, sans-serif; margin: 3rem;"><h1>Vision bridge connected</h1>' +
  "<p>You can close this tab and return to T3 Code.</p></body></html>";

const DENIED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vision login not completed</title></head>' +
  '<body style="font-family: system-ui, sans-serif; margin: 3rem;"><h1>Vision login not completed</h1>' +
  "<p>The authorization was not granted. You can close this tab.</p></body></html>";

const INVALID_CALLBACK = "Invalid Vision login callback.";

const oauthErrorSummary = (text: string): string =>
  Option.match(decodeOAuthErrorBody(text), {
    onNone: () => (text.trim() === "" ? "empty response" : text.trim().slice(0, 200)),
    onSome: (body) => body.error_description ?? body.error,
  });

const loopbackPort = (address: NetAddress.SocketAddress): Effect.Effect<number, OwnerAuthError> =>
  address._tag === "UnixPathAddress"
    ? Effect.fail(
        new OwnerAuthError({
          reason: "callback",
          detail: "the loopback callback server did not bind to a TCP port",
        }),
      )
    : Effect.succeed(address.port);

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const store = yield* TokenStore.TokenStore;
  const target = yield* Config.VisionMcpTarget;
  const browser = yield* BrowserOpener.BrowserOpener;
  const crypto = yield* Crypto.Crypto;
  const tokenSemaphore = yield* Semaphore.make(1);
  const loginSemaphore = yield* Semaphore.make(1);

  const storeError = (error: TokenStore.TokenStoreError) =>
    new OwnerAuthError({ reason: "store", detail: error.message });

  const getJson = Effect.fn("OwnerAuth.getJson")(function* <A>(
    reason: OwnerAuthError["reason"],
    url: string,
    decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
  ) {
    const request = HttpClientRequest.get(url, { headers: { accept: "application/json" } });
    const response = yield* Http.executeRaw(client, request).pipe(
      Effect.mapError(
        (error) =>
          new OwnerAuthError({
            reason,
            detail: `${url}: ${Http.describeTransportError(error)}`,
          }),
      ),
    );
    if (response.status !== 200) {
      return yield* new OwnerAuthError({
        reason,
        detail: `${url} answered HTTP ${response.status}`,
      });
    }
    return yield* decode(response.text).pipe(
      Effect.mapError(
        () => new OwnerAuthError({ reason, detail: `${url} returned a malformed document` }),
      ),
    );
  });

  const discover = Effect.fn("OwnerAuth.discover")(function* () {
    const resourceMetadata = yield* getJson(
      "discovery",
      `${target.origin}/.well-known/oauth-protected-resource${target.mcpUrl.pathname}`,
      decodeProtectedResourceMetadata,
    ).pipe(Effect.option);
    const issuer = Option.match(resourceMetadata, {
      onNone: () => target.origin,
      onSome: (metadata) => metadata.authorization_servers?.[0] ?? target.origin,
    }).replace(/\/+$/, "");
    const metadata = yield* getJson(
      "discovery",
      `${issuer}/.well-known/oauth-authorization-server`,
      decodeAuthorizationServerMetadata,
    );
    const server: AuthorizationServer = {
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint,
    };
    return server;
  });

  const makePkce = Effect.gen(function* () {
    const verifier = Base64Url.encode(yield* crypto.randomBytes(32));
    const challenge = Base64Url.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const state = Base64Url.encode(yield* crypto.randomBytes(16));
    return { verifier, challenge, state };
  }).pipe(
    Effect.mapError(
      (error) =>
        new OwnerAuthError({
          reason: "callback",
          detail: `could not generate PKCE material: ${error.message}`,
        }),
    ),
  );

  const registerClient = Effect.fn("OwnerAuth.registerClient")(function* (
    server: AuthorizationServer,
    redirectUri: string,
  ) {
    if (server.registrationEndpoint === undefined) {
      return yield* new OwnerAuthError({
        reason: "registration",
        detail: "the Vision authorization server does not offer dynamic client registration",
      });
    }
    const request = HttpClientRequest.post(server.registrationEndpoint, {
      headers: { accept: "application/json" },
    }).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPE,
      }),
    );
    const response = yield* Http.executeRaw(client, request).pipe(
      Effect.mapError(
        (error) =>
          new OwnerAuthError({
            reason: "registration",
            detail: Http.describeTransportError(error),
          }),
      ),
    );
    if (response.status !== 200 && response.status !== 201) {
      return yield* new OwnerAuthError({
        reason: "registration",
        detail: `HTTP ${response.status}: ${oauthErrorSummary(response.text)}`,
      });
    }
    const registration = yield* decodeRegistrationResponse(response.text).pipe(
      Effect.mapError(
        () =>
          new OwnerAuthError({
            reason: "registration",
            detail: "malformed client registration response",
          }),
      ),
    );
    return registration.client_id;
  });

  const requestToken = Effect.fn("OwnerAuth.requestToken")(function* (
    tokenEndpoint: string,
    params: Readonly<Record<string, string>>,
  ) {
    const request = HttpClientRequest.post(tokenEndpoint, {
      headers: { accept: "application/json" },
    }).pipe(HttpClientRequest.bodyUrlParams(params));
    const response = yield* Http.executeRaw(client, request).pipe(
      Effect.mapError(
        (error) =>
          new OwnerAuthError({ reason: "unavailable", detail: Http.describeTransportError(error) }),
      ),
    );
    if (response.status !== 200) {
      return yield* new OwnerAuthError({
        reason: response.status >= 500 ? "unavailable" : "token",
        detail: `HTTP ${response.status}: ${oauthErrorSummary(response.text)}`,
      });
    }
    return yield* decodeTokenResponse(response.text).pipe(
      Effect.mapError(
        () => new OwnerAuthError({ reason: "token", detail: "malformed token response" }),
      ),
    );
  });

  const toStored = (
    tokens: TokenResponse,
    clientId: string,
    tokenEndpoint: string,
    previousRefreshToken: string | undefined,
  ) =>
    Effect.map(Clock.currentTimeMillis, (now): TokenStore.StoredCredentials => {
      const refreshToken = tokens.refresh_token ?? previousRefreshToken;
      return {
        mcpUrl: target.resource,
        clientId,
        tokenEndpoint,
        accessToken: tokens.access_token,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        expiresAt: now + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
        scope: tokens.scope ?? SCOPE,
      };
    });

  const login = Effect.fn("OwnerAuth.login")(function* () {
    const server = yield* discover();
    const pkce = yield* makePkce;
    const callback = yield* Deferred.make<string, OwnerAuthError>();

    const routes = HttpRouter.add(
      "GET",
      "/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = new URL(request.originalUrl, "http://127.0.0.1").searchParams;
        if (params.get("state") !== pkce.state) {
          return HttpServerResponse.text(INVALID_CALLBACK, { status: 400 });
        }
        const error = params.get("error");
        if (error !== null) {
          yield* Deferred.fail(
            callback,
            new OwnerAuthError({
              reason: "denied",
              detail: params.get("error_description") ?? error,
            }),
          );
          return HttpServerResponse.html(DENIED_HTML);
        }
        const code = params.get("code");
        if (code === null) {
          return HttpServerResponse.text(INVALID_CALLBACK, { status: 400 });
        }
        yield* Deferred.succeed(callback, code);
        return HttpServerResponse.html(COMPLETE_HTML);
      }),
    );

    const serverContext = yield* HttpRouter.serve(routes, {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
      Effect.mapError(
        (cause) =>
          new OwnerAuthError({
            reason: "callback",
            detail: `could not start the loopback callback server: ${String(cause)}`,
          }),
      ),
    );
    const port = yield* loopbackPort(Context.get(serverContext, HttpServer.HttpServer).address);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const clientId = yield* registerClient(server, redirectUri);

    const authorizeUrl = new URL(server.authorizationEndpoint);
    const authorizeParams: Readonly<Record<string, string>> = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: target.resource,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
    };
    for (const [key, value] of Object.entries(authorizeParams)) {
      authorizeUrl.searchParams.set(key, value);
    }
    // The owner finishes the login in the browser; the bridge only waits for the
    // redirect and never sees or types the Vision connection key.
    yield* browser.open(authorizeUrl);

    const code = yield* Deferred.await(callback).pipe(
      Effect.timeout(CALLBACK_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new OwnerAuthError({
              reason: "timeout",
              detail: "the owner did not finish the browser login in time",
            }),
          ),
      }),
    );

    const tokens = yield* requestToken(server.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
      resource: target.resource,
    });
    const stored = yield* toStored(tokens, clientId, server.tokenEndpoint, undefined);
    yield* store.save(stored).pipe(Effect.mapError(storeError));
    return stored;
  });

  const loadForTarget = store.load.pipe(
    Effect.mapError(storeError),
    Effect.map((loaded) =>
      Option.filter(loaded, (credentials) => credentials.mcpUrl === target.resource),
    ),
  );

  const refreshStored = Effect.fn("OwnerAuth.refresh")(function* (
    stored: TokenStore.StoredCredentials,
  ) {
    if (stored.refreshToken === undefined) {
      yield* store.clear.pipe(Effect.mapError(storeError));
      return Option.none<string>();
    }
    const tokens = yield* requestToken(stored.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: stored.clientId,
      resource: target.resource,
    }).pipe(
      Effect.asSome,
      // A rejected refresh token means the owner has to log in again; transport
      // failures are reported instead so a flaky network does not log anyone out.
      Effect.catchIf(
        (error) => error.reason === "token",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(tokens)) {
      yield* store.clear.pipe(Effect.mapError(storeError));
      return Option.none<string>();
    }
    const next = yield* toStored(
      tokens.value,
      stored.clientId,
      stored.tokenEndpoint,
      stored.refreshToken,
    );
    yield* store.save(next).pipe(Effect.mapError(storeError));
    return Option.some(next.accessToken);
  });

  const currentAccessToken = tokenSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const stored = yield* loadForTarget;
      if (Option.isNone(stored)) {
        return Option.none<string>();
      }
      const now = yield* Clock.currentTimeMillis;
      if (stored.value.expiresAt - EARLY_REFRESH_MS > now) {
        return Option.some(stored.value.accessToken);
      }
      return yield* refreshStored(stored.value).pipe(Effect.uninterruptible);
    }),
  );

  const refreshAccessToken = tokenSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const stored = yield* loadForTarget;
      if (Option.isNone(stored)) {
        return Option.none<string>();
      }
      return yield* refreshStored(stored.value).pipe(Effect.uninterruptible);
    }),
  );

  const authenticate = loginSemaphore.withPermits(1)(Effect.scoped(login()).pipe(Effect.asVoid));

  const logout = store.clear.pipe(Effect.mapError(storeError));

  return { authenticate, currentAccessToken, refreshAccessToken, logout } satisfies OwnerAuthShape;
});

export const layer: Layer.Layer<
  OwnerAuth,
  never,
  | HttpClient.HttpClient
  | TokenStore.TokenStore
  | Config.VisionMcpTarget
  | BrowserOpener.BrowserOpener
  | Crypto.Crypto
> = Layer.effect(OwnerAuth, make);

export const layerUnavailable: Layer.Layer<OwnerAuth> = Layer.succeed(OwnerAuth, {
  authenticate: Effect.fail(
    new OwnerAuthError({
      reason: "unavailable",
      detail: `set ${Config.MCP_URL_ENV} to the Vision MCP endpoint before logging in`,
    }),
  ),
  currentAccessToken: Effect.succeedNone,
  refreshAccessToken: Effect.succeedNone,
  logout: Effect.void,
});
