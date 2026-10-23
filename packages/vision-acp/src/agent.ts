import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

import * as AcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import * as VisionClient from "./vision-client.ts";

export const AGENT_NAME = "vision-acp";
export const AGENT_VERSION = "0.1.0";

type ContentBlock = AcpSchema.PromptRequest["prompt"][number];
type SessionUpdate = AcpSchema.SessionNotification["update"];

interface ActiveTurn {
  readonly messageId: string;
  readonly fiber: Fiber.Fiber<void>;
}

interface SessionState {
  readonly cwd: string;
  readonly promptCount: number;
  readonly activeTurn: ActiveTurn | undefined;
}

export const flattenPrompt = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks
    .map((block) => (block.type === "text" ? block.text : `[${block.type} content omitted]`))
    .join("\n")
    .trim();

const describeOutcome = (status: VisionClient.VisionRequestStatus, requestId: string): string => {
  switch (status.state) {
    case "interrupted":
      return `Vision interrupted request ${requestId} before it finished: ${status.detail}. The request was not replayed; send it again if you still want it.`;
    case "failed":
      return `Vision rejected request ${requestId}: ${status.detail}`;
    default:
      return `Vision reported an unexpected state for request ${requestId}.`;
  }
};

export const register = Effect.fn("VisionAcp.register")(function* () {
  const agent = yield* AcpAgent.AcpAgent;
  const vision = yield* VisionClient.VisionClient;
  const scope = yield* Effect.scope;
  // Session ids double as idempotency keys toward Vision, so a restarted bridge
  // must not reuse ids from a previous process.
  const nonce = yield* Random.nextIntBetween(0, 0x1000000);
  const sessionPrefix = `vision-${nonce.toString(16).padStart(6, "0")}`;
  const sessionCounter = yield* Ref.make(0);
  const sessions = yield* Ref.make<ReadonlyMap<string, SessionState>>(new Map());

  const updateSession = (sessionId: string, update: (state: SessionState) => SessionState) =>
    Ref.update(sessions, (current) => {
      const state = current.get(sessionId);
      return state === undefined ? current : new Map(current).set(sessionId, update(state));
    });

  const emit = (sessionId: string, update: SessionUpdate) =>
    agent.client.sessionUpdate({ sessionId, update });

  const emitIdle = (sessionId: string, stopReason: AcpSchema.StopReason) =>
    emit(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason });

  const emitText = (sessionId: string, messageId: string, text: string) =>
    emit(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    });

  const runTurn = Effect.fn("VisionAcp.runTurn")(function* (
    sessionId: string,
    messageId: string,
    text: string,
  ) {
    const sent = yield* vision.sendMessage({ text, idempotencyKey: messageId });
    let status = yield* vision.getStatus(sent.requestId);
    while (status.state === "queued" || status.state === "running") {
      yield* Effect.sleep(Duration.seconds(status.retryAfterSeconds));
      status = yield* vision.getStatus(sent.requestId);
    }
    if (status.state === "done") {
      const reply = yield* vision.getReply(sent.requestId);
      yield* emitText(sessionId, messageId, reply.text);
      yield* emitIdle(sessionId, "end_turn");
      return;
    }
    yield* emitText(sessionId, messageId, describeOutcome(status, sent.requestId));
    yield* emitIdle(sessionId, "end_turn");
  });

  const createSession = Effect.fn("VisionAcp.createSession")(function* (
    request: AcpSchema.NewSessionRequest,
  ) {
    const index = yield* Ref.updateAndGet(sessionCounter, (n) => n + 1);
    const sessionId = `${sessionPrefix}-${index}`;
    yield* Ref.update(sessions, (current) =>
      new Map(current).set(sessionId, {
        cwd: request.cwd,
        promptCount: 0,
        activeTurn: undefined,
      }),
    );
    return { sessionId };
  });

  const prompt = Effect.fn("VisionAcp.prompt")(function* (request: AcpSchema.PromptRequest) {
    const sessionId = request.sessionId;
    const current = (yield* Ref.get(sessions)).get(sessionId);
    if (current === undefined) {
      return yield* AcpError.AcpRequestError.invalidParams(`unknown session ${sessionId}`);
    }
    if (current.activeTurn !== undefined) {
      yield* Fiber.interrupt(current.activeTurn.fiber);
    }
    const promptIndex = current.promptCount + 1;
    const messageId = `${sessionId}:${promptIndex}`;
    const text = flattenPrompt(request.prompt);

    yield* emit(sessionId, { sessionUpdate: "state_update", state: "running" });
    const fiber = yield* runTurn(sessionId, messageId, text).pipe(
      Effect.catchTags({
        VisionClientError: (error) =>
          emitText(sessionId, messageId, error.message).pipe(
            Effect.andThen(emitIdle(sessionId, "end_turn")),
          ),
      }),
      Effect.onInterrupt(() => emitIdle(sessionId, "cancelled").pipe(Effect.ignore)),
      Effect.catchCause((cause) =>
        Effect.logWarning("vision-acp turn ended with an unhandled failure", cause),
      ),
      Effect.ensuring(
        updateSession(sessionId, (state) =>
          state.activeTurn?.messageId === messageId ? { ...state, activeTurn: undefined } : state,
        ),
      ),
      Effect.forkIn(scope),
    );
    yield* updateSession(sessionId, (state) => ({
      ...state,
      promptCount: promptIndex,
      activeTurn: { messageId, fiber },
    }));
    return {};
  });

  const cancel = Effect.fn("VisionAcp.cancel")(function* (
    notification: AcpSchema.CancelNotification,
  ) {
    const current = (yield* Ref.get(sessions)).get(notification.sessionId);
    if (current?.activeTurn !== undefined) {
      yield* Fiber.interrupt(current.activeTurn.fiber);
    }
  });

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 2,
      capabilities: {},
      info: { name: AGENT_NAME, version: AGENT_VERSION },
    }),
  );
  yield* agent.handleCreateSession((request) => createSession(request));
  yield* agent.handlePrompt((request) => prompt(request));
  yield* agent.handleCancel((notification) => cancel(notification));
});
