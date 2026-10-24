import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Config from "./config.ts";
import * as McpTransport from "./mcp-transport.ts";
import * as OwnerAuth from "./oauth.ts";
import * as VisionClient from "./vision-client.ts";

export const NOT_AUTHENTICATED_DETAIL = `the bridge is not connected to Vision yet; run authenticate with the ${OwnerAuth.AUTH_METHOD_ID} method`;

const DEFAULT_RETRY_AFTER_SECONDS = 15;

const Receipt = Schema.Struct({
  request_id: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "interrupted"]),
  retry_after_seconds: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Unknown),
  reply: Schema.optional(Schema.String),
});
type Receipt = typeof Receipt.Type;

const decodeReceipt = Schema.decodeUnknownEffect(Receipt);

const IDEMPOTENCY_KEY_FORBIDDEN = /[^A-Za-z0-9_-]/g;

/** Vision accepts `^[A-Za-z0-9_-]{8,128}$`; ACP message ids contain other characters. */
export const toIdempotencyKey = (key: string): string =>
  key.replace(IDEMPOTENCY_KEY_FORBIDDEN, "-").padEnd(8, "0").slice(0, 128);

const describeReceiptError = (error: unknown, fallback: string): string => {
  if (typeof error === "string" && error !== "") {
    return error;
  }
  if (error === undefined || error === null) {
    return fallback;
  }
  return JSON.stringify(error);
};

export const toStatus = (receipt: Receipt): VisionClient.VisionRequestStatus => {
  switch (receipt.status) {
    case "queued":
    case "running":
      return {
        state: receipt.status,
        retryAfterSeconds: receipt.retry_after_seconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      };
    case "completed":
      return { state: "done" };
    case "failed":
    case "interrupted":
      return {
        state: receipt.status,
        detail: describeReceiptError(receipt.error, receipt.status),
      };
  }
};

export const layer: Layer.Layer<
  VisionClient.VisionClient,
  never,
  Config.VisionMcpTarget | OwnerAuth.OwnerAuth | HttpClient.HttpClient
> = Layer.effect(
  VisionClient.VisionClient,
  Effect.gen(function* () {
    const target = yield* Config.VisionMcpTarget;
    const auth = yield* OwnerAuth.OwnerAuth;
    const httpClient = yield* HttpClient.HttpClient;
    const counter = yield* Ref.make(0);

    const authError = (error: OwnerAuth.OwnerAuthError) =>
      new VisionClient.VisionClientError({ reason: "unavailable", detail: error.message });
    const notAuthenticated = new VisionClient.VisionClientError({
      reason: "unavailable",
      detail: NOT_AUTHENTICATED_DETAIL,
    });

    const callTool = Effect.fn("VisionClientLive.callTool")(function* (
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) {
      const token = yield* auth.currentAccessToken.pipe(Effect.mapError(authError));
      if (Option.isNone(token)) {
        return yield* notAuthenticated;
      }
      const id = yield* Ref.updateAndGet(counter, (n) => n + 1);
      const attempt = (accessToken: string) =>
        McpTransport.callTool({ mcpUrl: target.mcpUrl, accessToken, id, tool, args }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      return yield* attempt(token.value).pipe(
        Effect.catchTags({
          McpUnauthorized: () =>
            Effect.gen(function* () {
              const refreshed = yield* auth.refreshAccessToken.pipe(Effect.mapError(authError));
              if (Option.isNone(refreshed)) {
                return yield* notAuthenticated;
              }
              return yield* attempt(refreshed.value).pipe(
                Effect.catchTags({
                  McpUnauthorized: (error) =>
                    Effect.fail(
                      new VisionClient.VisionClientError({
                        reason: "unavailable",
                        detail: `Vision rejected the owner token: ${error.detail}`,
                      }),
                    ),
                }),
              );
            }),
        }),
      );
    });

    const decode = (value: unknown, tool: string) =>
      decodeReceipt(value).pipe(
        Effect.mapError(
          () =>
            new VisionClient.VisionClientError({
              reason: "protocol",
              detail: `Vision returned a malformed ${tool} receipt`,
            }),
        ),
      );

    const sendMessage = Effect.fn("VisionClientLive.sendMessage")(function* (
      input: VisionClient.VisionSendMessageInput,
    ) {
      const value = yield* callTool("send_message", {
        text: input.text,
        idempotency_key: toIdempotencyKey(input.idempotencyKey),
      });
      const receipt = yield* decode(value, "send_message");
      return { requestId: receipt.request_id };
    });

    const getStatus = Effect.fn("VisionClientLive.getStatus")(function* (requestId: string) {
      const value = yield* callTool("get_status", { request_id: requestId });
      return toStatus(yield* decode(value, "get_status"));
    });

    const getReply = Effect.fn("VisionClientLive.getReply")(function* (requestId: string) {
      const value = yield* callTool("get_reply", { request_id: requestId });
      const receipt = yield* decode(value, "get_reply");
      if (receipt.status !== "completed" || receipt.reply === undefined) {
        return yield* new VisionClient.VisionClientError({
          reason: "protocol",
          detail: `Vision has no reply for this request yet (status ${receipt.status})`,
          requestId,
        });
      }
      return { text: receipt.reply };
    });

    return { sendMessage, getStatus, getReply };
  }),
);
