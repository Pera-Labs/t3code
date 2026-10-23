import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { assert, it } from "@effect/vitest";

import * as AcpAgent from "effect-acp/agent";
import * as AcpSchema from "effect-acp/schema";

import * as VisionAcp from "./agent.ts";
import * as VisionClient from "./vision-client.ts";

const encoder = new TextEncoder();

const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

const JsonRpcVersion = Schema.Literal("2.0");

const InitializeMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: Schema.Number,
  method: Schema.Literal("initialize"),
  params: AcpSchema.InitializeRequest,
});
const NewSessionMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: Schema.Number,
  method: Schema.Literal("session/new"),
  params: AcpSchema.NewSessionRequest,
});
const PromptMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: Schema.Number,
  method: Schema.Literal("session/prompt"),
  params: AcpSchema.PromptRequest,
});
const CancelMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  method: Schema.Literal("session/cancel"),
  params: AcpSchema.CancelNotification,
});

// The bridge only ever emits these three update shapes. Decoding with a closed
// schema keeps the assertions precise and fails loudly on anything unexpected.
const StateUpdate = Schema.Union([
  Schema.Struct({
    sessionUpdate: Schema.Literal("state_update"),
    state: Schema.Literal("running"),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("state_update"),
    state: Schema.Literal("idle"),
    stopReason: Schema.Literals(["end_turn", "cancelled"]),
  }),
]);
const TextChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_message_chunk"),
  messageId: Schema.String,
  content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
});
const OutboundUpdate = Schema.Union([StateUpdate, TextChunk]);
type OutboundUpdate = typeof OutboundUpdate.Type;

const SessionUpdateMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  method: Schema.Literal("session/update"),
  params: Schema.Struct({ sessionId: Schema.String, update: OutboundUpdate }),
});
const ResponseMessage = Schema.Struct({
  jsonrpc: JsonRpcVersion,
  id: Schema.Number,
  result: Schema.Unknown,
});
const OutboundMessage = Schema.Union([SessionUpdateMessage, ResponseMessage]);
type OutboundMessage = typeof OutboundMessage.Type;

const decodeOutbound = Schema.decodeEffect(Schema.fromJsonString(OutboundMessage));
const decodeInitializeResponse = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, result: AcpSchema.InitializeResponse })),
);
const decodeNewSessionResponse = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, result: AcpSchema.NewSessionResponse })),
);

const encodeLine = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(schema))(value), (json) =>
    encoder.encode(`${json}\n`),
  );

interface RecordedCall {
  readonly text: string;
  readonly idempotencyKey: string;
}

interface FakeVisionOptions {
  readonly status: (requestId: string) => VisionClient.VisionRequestStatus;
  readonly replyText?: string;
}

const makeFakeVision = Effect.fn("makeFakeVision")(function* (options: FakeVisionOptions) {
  const calls = yield* Ref.make<ReadonlyArray<RecordedCall>>([]);
  const statusCalls = yield* Ref.make(0);
  const service: VisionClient.VisionClient["Service"] = {
    sendMessage: (input) =>
      Ref.update(calls, (current) => [...current, input]).pipe(
        Effect.as({ requestId: `req-${input.idempotencyKey}` }),
      ),
    getStatus: (requestId) =>
      Ref.update(statusCalls, (n) => n + 1).pipe(Effect.as(options.status(requestId))),
    getReply: () => Effect.succeed({ text: options.replyText ?? "" }),
  };
  return { layer: Layer.succeed(VisionClient.VisionClient, service), calls, statusCalls };
});

const makeHarness = Effect.fn("makeHarness")(function* (
  visionLayer: Layer.Layer<VisionClient.VisionClient>,
) {
  const { stdio, input, output } = yield* makeInMemoryStdio();
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    Layer.merge(AcpAgent.layer(stdio), visionLayer),
    scope,
  );
  yield* VisionAcp.register().pipe(
    Effect.provide(context),
    Effect.provideService(Scope.Scope, scope),
  );

  const send = (line: Uint8Array) => Queue.offer(input, line);

  const initialize = Effect.gen(function* () {
    yield* send(
      yield* encodeLine(InitializeMessage, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 2,
          info: { name: "vision-acp-test-client", version: "0.0.0" },
        },
      }),
    );
    return yield* decodeInitializeResponse(yield* Queue.take(output));
  });

  const newSession = Effect.gen(function* () {
    yield* send(
      yield* encodeLine(NewSessionMessage, {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "/workspace", mcpServers: [] },
      }),
    );
    const response = yield* decodeNewSessionResponse(yield* Queue.take(output));
    return response.result.sessionId;
  });

  const prompt = (id: number, sessionId: string, text: string) =>
    Effect.gen(function* () {
      yield* send(
        yield* encodeLine(PromptMessage, {
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text }] },
        }),
      );
    });

  const cancel = (sessionId: string) =>
    Effect.gen(function* () {
      yield* send(
        yield* encodeLine(CancelMessage, {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId },
        }),
      );
    });

  const takeOutbound = (count: number) =>
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      () => Effect.flatMap(Queue.take(output), decodeOutbound),
    );

  const close = Scope.close(scope, Exit.void);

  return { initialize, newSession, prompt, cancel, takeOutbound, close };
});

const sessionUpdates = (messages: ReadonlyArray<OutboundMessage>) =>
  messages.flatMap((message) => ("method" in message ? [message.params.update] : []));

const responses = (messages: ReadonlyArray<OutboundMessage>) =>
  messages.flatMap((message) => ("id" in message ? [message] : []));

const chunkText = (update: OutboundUpdate | undefined): string => {
  if (update?.sessionUpdate !== "agent_message_chunk") {
    return assert.fail(`expected an agent_message_chunk, got ${String(update?.sessionUpdate)}`);
  }
  return update.content.text;
};

it.effect("initialize advertises the bridge identity and session/new mints unique ids", () =>
  Effect.gen(function* () {
    const vision = yield* makeFakeVision({ status: () => ({ state: "done" }) });
    const harness = yield* makeHarness(vision.layer);

    yield* Effect.gen(function* () {
      const initialized = yield* harness.initialize;
      assert.strictEqual(initialized.id, 1);
      assert.strictEqual(initialized.result.protocolVersion, 2);
      assert.deepStrictEqual(initialized.result.info, {
        name: VisionAcp.AGENT_NAME,
        version: VisionAcp.AGENT_VERSION,
      });

      const first = yield* harness.newSession;
      const second = yield* harness.newSession;
      assert.match(first, /^vision-[0-9a-f]{6}-1$/);
      assert.match(second, /^vision-[0-9a-f]{6}-2$/);
      assert.notStrictEqual(first, second);
    }).pipe(Effect.ensuring(harness.close));
  }),
);

it.effect("prompt relays the text to Vision and streams running, reply, idle", () =>
  Effect.gen(function* () {
    const vision = yield* makeFakeVision({
      status: () => ({ state: "done" }),
      replyText: "Vision says hello",
    });
    const harness = yield* makeHarness(vision.layer);

    yield* Effect.gen(function* () {
      yield* harness.initialize;
      const sessionId = yield* harness.newSession;
      yield* harness.prompt(3, sessionId, "hello from the client");

      const messages = yield* harness.takeOutbound(4);
      const replies = responses(messages);
      assert.strictEqual(replies.length, 1);
      assert.strictEqual(replies[0]?.id, 3);
      assert.deepStrictEqual(replies[0]?.result, {});

      assert.deepStrictEqual(sessionUpdates(messages), [
        { sessionUpdate: "state_update", state: "running" },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: `${sessionId}:1`,
          content: { type: "text", text: "Vision says hello" },
        },
        { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      ]);

      assert.deepStrictEqual(yield* Ref.get(vision.calls), [
        { text: "hello from the client", idempotencyKey: `${sessionId}:1` },
      ]);
    }).pipe(Effect.ensuring(harness.close));
  }),
);

it.effect("an interrupted Vision request surfaces the request id and does not replay", () =>
  Effect.gen(function* () {
    const vision = yield* makeFakeVision({
      status: () => ({ state: "interrupted", detail: "owner closed the window" }),
    });
    const harness = yield* makeHarness(vision.layer);

    yield* Effect.gen(function* () {
      yield* harness.initialize;
      const sessionId = yield* harness.newSession;
      yield* harness.prompt(3, sessionId, "do the thing");

      const updates = sessionUpdates(yield* harness.takeOutbound(4));
      const text = chunkText(updates[1]);
      assert.include(text, `req-${sessionId}:1`);
      assert.include(text, "owner closed the window");
      assert.include(text, "not replayed");
      assert.deepStrictEqual(updates[2], {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      });
      assert.strictEqual((yield* Ref.get(vision.calls)).length, 1);
    }).pipe(Effect.ensuring(harness.close));
  }),
);

it.effect("session/cancel interrupts a waiting turn and reports idle with cancelled", () =>
  Effect.gen(function* () {
    const vision = yield* makeFakeVision({
      status: () => ({ state: "running", retryAfterSeconds: 15 }),
    });
    const harness = yield* makeHarness(vision.layer);

    yield* Effect.gen(function* () {
      yield* harness.initialize;
      const sessionId = yield* harness.newSession;
      yield* harness.prompt(3, sessionId, "long running work");

      const beforeCancel = yield* harness.takeOutbound(2);
      assert.deepStrictEqual(sessionUpdates(beforeCancel), [
        { sessionUpdate: "state_update", state: "running" },
      ]);
      assert.strictEqual(responses(beforeCancel).length, 1);

      yield* harness.cancel(sessionId);
      assert.deepStrictEqual(sessionUpdates(yield* harness.takeOutbound(1)), [
        { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" },
      ]);
      assert.strictEqual(yield* Ref.get(vision.statusCalls), 1);
    }).pipe(Effect.ensuring(harness.close));
  }),
);

it.effect("the unavailable client answers every prompt with an explanation and idles", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(VisionClient.layerUnavailable);

    yield* Effect.gen(function* () {
      yield* harness.initialize;
      const sessionId = yield* harness.newSession;
      yield* harness.prompt(3, sessionId, "anyone there?");

      const updates = sessionUpdates(yield* harness.takeOutbound(4));
      assert.include(chunkText(updates[1]), "Vision unavailable");
      assert.deepStrictEqual(updates[2], {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      });
    }).pipe(Effect.ensuring(harness.close));
  }),
);
