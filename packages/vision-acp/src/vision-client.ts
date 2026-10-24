import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Config from "./config.ts";

export class VisionClientError extends Schema.TaggedError<VisionClientError>()(
  "VisionClientError",
  {
    reason: Schema.Literals(["unavailable", "rejected", "interrupted", "protocol"]),
    detail: Schema.String,
    requestId: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.requestId === undefined
      ? `Vision ${this.reason}: ${this.detail}`
      : `Vision ${this.reason} (request ${this.requestId}): ${this.detail}`;
  }
}

export const VisionRequestStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["queued", "running"]),
    retryAfterSeconds: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("done") }),
  Schema.Struct({
    state: Schema.Literals(["interrupted", "failed"]),
    detail: Schema.String,
  }),
]);
export type VisionRequestStatus = typeof VisionRequestStatus.Type;

export interface VisionSendMessageInput {
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface VisionSendMessageResult {
  readonly requestId: string;
}

export interface VisionReply {
  readonly text: string;
}

export class VisionClient extends Context.Service<
  VisionClient,
  {
    readonly sendMessage: (
      input: VisionSendMessageInput,
    ) => Effect.Effect<VisionSendMessageResult, VisionClientError>;
    readonly getStatus: (
      requestId: string,
    ) => Effect.Effect<VisionRequestStatus, VisionClientError>;
    readonly getReply: (requestId: string) => Effect.Effect<VisionReply, VisionClientError>;
  }
>()("@t3tools/vision-acp/vision-client/VisionClient") {}

const UNAVAILABLE_DETAIL = `${Config.MCP_URL_ENV} is not set for this provider instance, so the bridge accepts sessions but cannot deliver messages`;

const unavailable: Effect.Effect<never, VisionClientError> = Effect.fail(
  new VisionClientError({ reason: "unavailable", detail: UNAVAILABLE_DETAIL }),
);

export const layerUnavailable: Layer.Layer<VisionClient> = Layer.succeed(VisionClient, {
  sendMessage: () => unavailable,
  getStatus: () => unavailable,
  getReply: () => unavailable,
});
