// @effect-diagnostics nodeBuiltinImport:off - the fake Vision MCP server listens on a real loopback socket
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { assert, it } from "@effect/vitest";

import * as Config from "./config.ts";
import * as McpTransport from "./mcp-transport.ts";
import * as OwnerAuth from "./oauth.ts";
import * as VisionClient from "./vision-client.ts";
import * as VisionClientLive from "./vision-client-live.ts";

const ToolCallRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
const decodeToolCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallRequest));
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface RecordedCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly token: string | undefined;
  readonly accept: string | undefined;
  readonly contentType: string | undefined;
}

type ScriptedResult =
  | { readonly kind: "receipt"; readonly receipt: Readonly<Record<string, unknown>> }
  | { readonly kind: "toolError"; readonly code: string };

interface FakeVisionMcp {
  readonly mcpUrl: string;
  readonly calls: Ref.Ref<ReadonlyArray<RecordedCall>>;
  readonly validTokens: Ref.Ref<ReadonlySet<string>>;
  readonly script: Ref.Ref<(call: RecordedCall) => ScriptedResult>;
}

const append =
  <A>(value: A) =>
  (values: ReadonlyArray<A>) => [...values, value];

const receipt = (fields: Readonly<Record<string, unknown>>): ScriptedResult => ({
  kind: "receipt",
  receipt: fields,
});

const toolError = (code: string): ScriptedResult => ({ kind: "toolError", code });

const startFakeVisionMcp = Effect.fn("startFakeVisionMcp")(function* (
  initialScript: (call: RecordedCall) => ScriptedResult,
) {
  const calls = yield* Ref.make<ReadonlyArray<RecordedCall>>([]);
  const validTokens = yield* Ref.make<ReadonlySet<string>>(new Set(["token-1"]));
  const script = yield* Ref.make(initialScript);

  const routes = HttpRouter.add(
    "POST",
    "/mcp",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const accept = request.headers["accept"];
      const contentType = request.headers["content-type"];
      if (
        accept === undefined ||
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream")
      ) {
        return HttpServerResponse.text("Not Acceptable", { status: 406 });
      }
      if (contentType === undefined || !contentType.includes("application/json")) {
        return HttpServerResponse.text("Unsupported Media Type", { status: 415 });
      }
      const authorization = request.headers["authorization"];
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const tokens = yield* Ref.get(validTokens);
      const body = yield* decodeToolCall(yield* request.text.pipe(Effect.orDie)).pipe(Effect.orDie);
      const call: RecordedCall = {
        tool: body.params.name,
        args: body.params.arguments,
        token,
        accept,
        contentType,
      };
      yield* Ref.update(calls, append(call));
      if (token === undefined || !tokens.has(token)) {
        return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 });
      }
      const scripted = (yield* Ref.get(script))(call);
      const result =
        scripted.kind === "receipt"
          ? {
              content: [{ type: "text", text: toJsonText(scripted.receipt) }],
              structuredContent: scripted.receipt,
            }
          : {
              content: [{ type: "text", text: toJsonText({ error: scripted.code }) }],
              isError: true,
            };
      return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: body.id, result });
    }),
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
    return yield* Effect.die("expected the fake Vision MCP server on a TCP port");
  }
  const fake: FakeVisionMcp = {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    validTokens,
    script,
  };
  return fake;
});

const makeFakeAuth = Effect.fn("makeFakeAuth")(function* (initialToken: Option.Option<string>) {
  const token = yield* Ref.make(initialToken);
  const refreshes = yield* Ref.make(0);
  const service: OwnerAuth.OwnerAuthShape = {
    authenticate: Effect.void,
    currentAccessToken: Ref.get(token),
    refreshAccessToken: Effect.gen(function* () {
      yield* Ref.update(refreshes, (n) => n + 1);
      const current = yield* Ref.get(token);
      if (Option.isNone(current)) {
        return Option.none<string>();
      }
      const next = "token-2";
      yield* Ref.set(token, Option.some(next));
      return Option.some(next);
    }),
    logout: Ref.set(token, Option.none()),
  };
  return { layer: Layer.succeed(OwnerAuth.OwnerAuth, service), refreshes };
});

const makeHarness = Effect.fn("makeHarness")(function* (
  initialScript: (call: RecordedCall) => ScriptedResult,
  initialToken: Option.Option<string> = Option.some("token-1"),
) {
  const server = yield* startFakeVisionMcp(initialScript);
  const auth = yield* makeFakeAuth(initialToken);
  const client = Context.get(
    yield* Layer.build(
      VisionClientLive.layer.pipe(
        Layer.provide(
          Layer.mergeAll(Config.layer(server.mcpUrl), auth.layer, NodeHttpClient.layerUndici),
        ),
      ),
    ),
    VisionClient.VisionClient,
  );
  return { server, auth, client };
});

const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const queuedReceipt = (call: RecordedCall): ScriptedResult => {
  switch (call.tool) {
    case "send_message":
      return receipt({ request_id: "req-1", status: "queued", retry_after_seconds: 4 });
    case "get_status":
      return receipt({ request_id: "req-1", status: "running", retry_after_seconds: 9 });
    default:
      return receipt({ request_id: "req-1", status: "completed", reply: "hello from vision" });
  }
};

it.effect("sendMessage posts a Streamable HTTP tool call with the owner token", () =>
  withServices(
    Effect.gen(function* () {
      const { server, client } = yield* makeHarness(queuedReceipt);

      const result = yield* client.sendMessage({ text: "hi", idempotencyKey: "vision-abc:1" });

      assert.deepStrictEqual(result, { requestId: "req-1" });
      const calls = yield* Ref.get(server.calls);
      assert.lengthOf(calls, 1);
      assert.strictEqual(calls[0]?.tool, "send_message");
      assert.deepStrictEqual(calls[0]?.args, { text: "hi", idempotency_key: "vision-abc-1" });
      assert.strictEqual(calls[0]?.token, "token-1");
      assert.strictEqual(calls[0]?.accept, McpTransport.MCP_ACCEPT);
      assert.include(calls[0]?.contentType ?? "", "application/json");
    }),
  ),
);

it.effect("getStatus and getReply map Vision receipts to client statuses", () =>
  withServices(
    Effect.gen(function* () {
      const { client } = yield* makeHarness(queuedReceipt);

      assert.deepStrictEqual(yield* client.getStatus("req-1"), {
        state: "running",
        retryAfterSeconds: 9,
      });
      assert.deepStrictEqual(yield* client.getReply("req-1"), { text: "hello from vision" });
    }),
  ),
);

it.effect("a 401 refreshes the owner token once and retries the same call", () =>
  withServices(
    Effect.gen(function* () {
      const { server, auth, client } = yield* makeHarness(queuedReceipt);
      yield* Ref.set(server.validTokens, new Set(["token-2"]));

      const result = yield* client.sendMessage({ text: "hi", idempotencyKey: "vision-abc:2" });

      assert.deepStrictEqual(result, { requestId: "req-1" });
      assert.strictEqual(yield* Ref.get(auth.refreshes), 1);
      const tokens = (yield* Ref.get(server.calls)).map((call) => call.token);
      assert.deepStrictEqual(tokens, ["token-1", "token-2"]);
    }),
  ),
);

it.effect("a second 401 after refreshing surfaces as unavailable", () =>
  withServices(
    Effect.gen(function* () {
      const { server, auth, client } = yield* makeHarness(queuedReceipt);
      yield* Ref.set(server.validTokens, new Set());

      const error = yield* client.getStatus("req-1").pipe(Effect.flip);

      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.detail, "rejected the owner token");
      assert.strictEqual(yield* Ref.get(auth.refreshes), 1);
      assert.lengthOf(yield* Ref.get(server.calls), 2);
    }),
  ),
);

it.effect("tool errors keep Vision's error code and map it to a reason", () =>
  withServices(
    Effect.gen(function* () {
      const { server, client } = yield* makeHarness(() => toolError("queue_full"));

      const unavailable = yield* client
        .sendMessage({ text: "hi", idempotencyKey: "vision-abc:3" })
        .pipe(Effect.flip);
      assert.strictEqual(unavailable.reason, "unavailable");
      assert.include(unavailable.detail, "queue_full");

      yield* Ref.set(server.script, () => toolError("invalid_arguments"));
      const rejected = yield* client.getReply("req-1").pipe(Effect.flip);
      assert.strictEqual(rejected.reason, "rejected");
      assert.include(rejected.detail, "invalid_arguments");
    }),
  ),
);

it.effect("getReply refuses receipts that are not completed yet", () =>
  withServices(
    Effect.gen(function* () {
      const { client } = yield* makeHarness(() =>
        receipt({ request_id: "req-1", status: "running", retry_after_seconds: 3 }),
      );

      const error = yield* client.getReply("req-1").pipe(Effect.flip);

      assert.strictEqual(error.reason, "protocol");
      assert.strictEqual(error.requestId, "req-1");
      assert.include(error.detail, "running");
    }),
  ),
);

it.effect("calls fail as unavailable before the owner has logged in", () =>
  withServices(
    Effect.gen(function* () {
      const { server, client } = yield* makeHarness(queuedReceipt, Option.none());

      const error = yield* client
        .sendMessage({ text: "hi", idempotencyKey: "vision-abc:4" })
        .pipe(Effect.flip);

      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(error.detail, VisionClientLive.NOT_AUTHENTICATED_DETAIL);
      assert.lengthOf(yield* Ref.get(server.calls), 0);
    }),
  ),
);

it("toIdempotencyKey keeps keys inside Vision's allowed alphabet and length", () => {
  assert.strictEqual(VisionClientLive.toIdempotencyKey("vision-xxxxxx-1:1"), "vision-xxxxxx-1-1");
  assert.strictEqual(VisionClientLive.toIdempotencyKey("a:b"), "a-b00000");
  assert.lengthOf(VisionClientLive.toIdempotencyKey("k".repeat(200)), 128);
});

it("toStatus maps failed receipts to a readable detail", () => {
  assert.deepStrictEqual(
    VisionClientLive.toStatus({ request_id: "req-1", status: "failed", error: "provider down" }),
    { state: "failed", detail: "provider down" },
  );
  assert.deepStrictEqual(
    VisionClientLive.toStatus({ request_id: "req-1", status: "interrupted" }),
    { state: "interrupted", detail: "interrupted" },
  );
  assert.deepStrictEqual(VisionClientLive.toStatus({ request_id: "req-1", status: "queued" }), {
    state: "queued",
    retryAfterSeconds: 15,
  });
});
