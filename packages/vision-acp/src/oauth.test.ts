// @effect-diagnostics nodeBuiltinImport:off - the fake Vision authorization server listens on a real loopback socket
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { assert, it } from "@effect/vitest";

import * as BrowserOpener from "./browser-opener.ts";
import * as Config from "./config.ts";
import * as OwnerAuth from "./oauth.ts";
import * as TokenStore from "./token-store.ts";

const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:\d+\/callback$/;

const RegistrationRequest = Schema.Struct({
  client_name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.String,
  grant_types: Schema.Array(Schema.String),
  scope: Schema.String,
});
const registrationBody = HttpServerRequest.schemaBodyJson(RegistrationRequest);

interface AuthorizeRequest {
  readonly params: Readonly<Record<string, string>>;
}

interface TokenRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly verifierMatched: boolean;
}

interface FakeAuthorizationServer {
  readonly origin: string;
  readonly registrations: Ref.Ref<ReadonlyArray<typeof RegistrationRequest.Type>>;
  readonly authorizations: Ref.Ref<ReadonlyArray<AuthorizeRequest>>;
  readonly tokenRequests: Ref.Ref<ReadonlyArray<TokenRequest>>;
  /** When set, the next authorize call sends the owner back with an OAuth error. */
  readonly denyNext: Ref.Ref<boolean>;
}

const searchParamsOf = (request: HttpServerRequest.HttpServerRequest, origin: string) =>
  Object.fromEntries(new URL(request.originalUrl, origin).searchParams);

const formParamsOf = (text: string) => Object.fromEntries(new URLSearchParams(text));

const append =
  <A>(value: A) =>
  (values: ReadonlyArray<A>) => [...values, value];

const s256 = Effect.fn("s256")(function* (verifier: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .pipe(Effect.orDie);
  return Base64Url.encode(digest);
});

/**
 * Starts a minimal OAuth 2.1 authorization server that speaks the subset the
 * bridge relies on: discovery, dynamic registration, PKCE authorize and token
 * exchange with rotating refresh tokens. `refresh-2` is the last valid refresh
 * token so tests can observe a forced re-login.
 */
const startFakeAuthorizationServer = Effect.fn("startFakeAuthorizationServer")(function* () {
  const registrations = yield* Ref.make<ReadonlyArray<typeof RegistrationRequest.Type>>([]);
  const authorizations = yield* Ref.make<ReadonlyArray<AuthorizeRequest>>([]);
  const tokenRequests = yield* Ref.make<ReadonlyArray<TokenRequest>>([]);
  const denyNext = yield* Ref.make(false);
  const originRef = yield* Ref.make("");
  const pendingChallenge = yield* Ref.make<Option.Option<string>>(Option.none());

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      Effect.gen(function* () {
        const origin = yield* Ref.get(originRef);
        return HttpServerResponse.jsonUnsafe({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/oauth-authorization-server",
      Effect.gen(function* () {
        const origin = yield* Ref.get(originRef);
        return HttpServerResponse.jsonUnsafe({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/register",
      Effect.gen(function* () {
        const body = yield* registrationBody.pipe(Effect.orDie);
        yield* Ref.update(registrations, append(body));
        return HttpServerResponse.jsonUnsafe({ client_id: "client-1" }, { status: 201 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = yield* Ref.get(originRef);
        const params = searchParamsOf(request, origin);
        yield* Ref.update(authorizations, append({ params }));
        const redirect = new URL(params["redirect_uri"] ?? "");
        redirect.searchParams.set("state", params["state"] ?? "");
        const deny = yield* Ref.getAndSet(denyNext, false);
        if (deny) {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", "The owner declined the request.");
        } else {
          yield* Ref.set(pendingChallenge, Option.fromNullishOr(params["code_challenge"]));
          redirect.searchParams.set("code", "code-1");
        }
        return HttpServerResponse.redirect(redirect, { status: 302 });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = formParamsOf(yield* request.text.pipe(Effect.orDie));
        if (params["grant_type"] === "authorization_code") {
          const challenge = yield* Ref.get(pendingChallenge);
          const expected = yield* s256(params["code_verifier"] ?? "");
          const verifierMatched = Option.contains(challenge, expected);
          yield* Ref.update(tokenRequests, append({ params, verifierMatched }));
          if (params["code"] !== "code-1" || !verifierMatched) {
            return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400 });
          }
          return HttpServerResponse.jsonUnsafe({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-1",
            scope: OwnerAuth.SCOPE,
          });
        }
        yield* Ref.update(tokenRequests, append<TokenRequest>({ params, verifierMatched: false }));
        if (params["grant_type"] === "refresh_token" && params["refresh_token"] === "refresh-1") {
          return HttpServerResponse.jsonUnsafe({
            access_token: "access-2",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-2",
            scope: OwnerAuth.SCOPE,
          });
        }
        return HttpServerResponse.jsonUnsafe(
          { error: "invalid_grant", error_description: "refresh token expired" },
          { status: 400 },
        );
      }),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
    ),
  );
  const address = Context.get(server, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die("expected the fake authorization server on a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  yield* Ref.set(originRef, origin);

  const fake: FakeAuthorizationServer = {
    origin,
    registrations,
    authorizations,
    tokenRequests,
    denyNext,
  };
  return fake;
});

/** Plays the owner: opens the authorize page and follows the redirect back to the bridge. */
const layerFakeBrowser: Layer.Layer<BrowserOpener.BrowserOpener> = Layer.effect(
  BrowserOpener.BrowserOpener,
  Effect.map(HttpClient.HttpClient, (client) => {
    const browser = client.pipe(HttpClient.followRedirects(3));
    return {
      open: (url: URL) => browser.get(url).pipe(Effect.asVoid, Effect.orDie),
    };
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici));

const makeHarness = Effect.fn("makeHarness")(function* () {
  const server = yield* startFakeAuthorizationServer();
  const store = Context.get(yield* Layer.build(TokenStore.layerMemory), TokenStore.TokenStore);
  const auth = Context.get(
    yield* Layer.build(
      OwnerAuth.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Config.layer(`${server.origin}/mcp`),
            Layer.succeed(TokenStore.TokenStore, store),
            layerFakeBrowser,
            NodeHttpClient.layerUndici,
          ),
        ),
      ),
    ),
    OwnerAuth.OwnerAuth,
  );
  return { server, store, auth };
});

const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("authenticate registers the bridge, completes PKCE and stores the owner tokens", () =>
  withServices(
    Effect.gen(function* () {
      const { server, store, auth } = yield* makeHarness();

      yield* auth.authenticate;

      const stored = yield* store.load;
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.strictEqual(stored.value.accessToken, "access-1");
        assert.strictEqual(stored.value.refreshToken, "refresh-1");
        assert.strictEqual(stored.value.clientId, "client-1");
        assert.strictEqual(stored.value.mcpUrl, `${server.origin}/mcp`);
        assert.strictEqual(stored.value.tokenEndpoint, `${server.origin}/token`);
        assert.strictEqual(stored.value.scope, OwnerAuth.SCOPE);
        assert.strictEqual(stored.value.expiresAt, 3_600_000);
      }

      const registrations = yield* Ref.get(server.registrations);
      assert.lengthOf(registrations, 1);
      assert.match(registrations[0]?.redirect_uris[0] ?? "", LOOPBACK_CALLBACK);
      assert.strictEqual(registrations[0]?.token_endpoint_auth_method, "none");
      assert.strictEqual(registrations[0]?.client_name, OwnerAuth.CLIENT_NAME);

      const authorizations = yield* Ref.get(server.authorizations);
      assert.lengthOf(authorizations, 1);
      const params = authorizations[0]?.params ?? {};
      assert.strictEqual(params["response_type"], "code");
      assert.strictEqual(params["client_id"], "client-1");
      assert.strictEqual(params["scope"], OwnerAuth.SCOPE);
      assert.strictEqual(params["resource"], `${server.origin}/mcp`);
      assert.strictEqual(params["code_challenge_method"], "S256");
      assert.strictEqual(params["redirect_uri"], registrations[0]?.redirect_uris[0]);

      const tokenRequests = yield* Ref.get(server.tokenRequests);
      assert.lengthOf(tokenRequests, 1);
      assert.isTrue(tokenRequests[0]?.verifierMatched);
      assert.strictEqual(tokenRequests[0]?.params["resource"], `${server.origin}/mcp`);

      assert.deepStrictEqual(yield* auth.currentAccessToken, Option.some("access-1"));
    }),
  ),
);

it.effect("currentAccessToken refreshes once the stored token is about to expire", () =>
  withServices(
    Effect.gen(function* () {
      const { server, store, auth } = yield* makeHarness();
      yield* auth.authenticate;

      yield* TestClock.adjust("59 minutes");
      assert.deepStrictEqual(yield* auth.currentAccessToken, Option.some("access-1"));

      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* auth.currentAccessToken, Option.some("access-2"));

      const stored = yield* store.load;
      assert.deepStrictEqual(
        Option.map(stored, (c) => c.refreshToken),
        Option.some("refresh-2"),
      );
      assert.deepStrictEqual(
        Option.map(stored, (c) => c.expiresAt),
        Option.some(7_200_000),
      );

      const tokenRequests = yield* Ref.get(server.tokenRequests);
      assert.strictEqual(tokenRequests[1]?.params["grant_type"], "refresh_token");
      assert.strictEqual(tokenRequests[1]?.params["refresh_token"], "refresh-1");
      assert.strictEqual(tokenRequests[1]?.params["client_id"], "client-1");
    }),
  ),
);

it.effect("a rejected refresh token logs the owner out instead of failing", () =>
  withServices(
    Effect.gen(function* () {
      const { store, auth } = yield* makeHarness();
      yield* auth.authenticate;

      assert.deepStrictEqual(yield* auth.refreshAccessToken, Option.some("access-2"));
      assert.deepStrictEqual(yield* auth.refreshAccessToken, Option.none());
      assert.deepStrictEqual(yield* store.load, Option.none());
      assert.deepStrictEqual(yield* auth.currentAccessToken, Option.none());
    }),
  ),
);

it.effect("authenticate reports a denied login and keeps the store empty", () =>
  withServices(
    Effect.gen(function* () {
      const { server, store, auth } = yield* makeHarness();
      yield* Ref.set(server.denyNext, true);

      const error = yield* auth.authenticate.pipe(Effect.flip);

      assert.strictEqual(error.reason, "denied");
      assert.include(error.detail, "declined");
      assert.deepStrictEqual(yield* store.load, Option.none());
      assert.lengthOf(yield* Ref.get(server.tokenRequests), 0);
    }),
  ),
);

it.effect("credentials stored for another Vision deployment are ignored", () =>
  withServices(
    Effect.gen(function* () {
      const { auth, store } = yield* makeHarness();
      yield* store.save({
        mcpUrl: "https://vision.example.invalid/mcp",
        clientId: "client-other",
        tokenEndpoint: "https://vision.example.invalid/token",
        accessToken: "access-other",
        expiresAt: 3_600_000,
        scope: OwnerAuth.SCOPE,
      });

      assert.deepStrictEqual(yield* auth.currentAccessToken, Option.none());
      assert.deepStrictEqual(yield* auth.refreshAccessToken, Option.none());
    }),
  ),
);

it.effect("layerUnavailable refuses to log in until the MCP URL is configured", () =>
  Effect.gen(function* () {
    const auth = Context.get(yield* Layer.build(OwnerAuth.layerUnavailable), OwnerAuth.OwnerAuth);
    const error = yield* auth.authenticate.pipe(Effect.flip);
    assert.strictEqual(error.reason, "unavailable");
    assert.include(error.detail, Config.MCP_URL_ENV);
    assert.deepStrictEqual(yield* auth.currentAccessToken, Option.none());
  }).pipe(Effect.scoped),
);
