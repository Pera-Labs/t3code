import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import * as Http from "./http.ts";
import * as VisionClient from "./vision-client.ts";

/** Streamable HTTP servers reject tool calls unless both media types are acceptable. */
export const MCP_ACCEPT = "application/json, text/event-stream";

export class McpUnauthorized extends Schema.TaggedError<McpUnauthorized>()("McpUnauthorized", {
  detail: Schema.String,
}) {}

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

const ToolResult = Schema.Struct({
  content: Schema.optional(Schema.Array(ContentBlock)),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});

const JsonRpcResponse = Schema.Union([
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), result: ToolResult }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
  }),
]);

const ToolErrorBody = Schema.Struct({ error: Schema.String });

const decodeJsonRpcResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcResponse));
const decodeToolErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ToolErrorBody));
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Reason = VisionClient.VisionClientError["reason"];

const UNAVAILABLE_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "not_ready",
  "queue_full",
  "context_unavailable",
  "mcp_record_limit",
]);

export const reasonForToolError = (code: string): Reason => {
  if (UNAVAILABLE_TOOL_ERRORS.has(code)) {
    return "unavailable";
  }
  return code === "unknown_tool" ? "protocol" : "rejected";
};

const reasonForStatus = (status: number): Reason =>
  status === 400 || status === 403 || status === 406 || status === 415 ? "protocol" : "unavailable";

const summarizeBody = (text: string): string => {
  const trimmed = text.trim();
  return trimmed === "" ? "" : `: ${trimmed.slice(0, 200)}`;
};

const protocolError = (detail: string) =>
  new VisionClient.VisionClientError({ reason: "protocol", detail });

export interface McpToolCall {
  readonly mcpUrl: URL;
  readonly accessToken: string;
  readonly id: number;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Calls one MCP tool over stateless Streamable HTTP and returns its structured
 * value. A 401 surfaces as `McpUnauthorized` so the caller can refresh the owner
 * token once and retry; everything else is already a `VisionClientError`.
 */
export const callTool = Effect.fn("McpTransport.callTool")(function* (call: McpToolCall) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(call.mcpUrl, {
    headers: { accept: MCP_ACCEPT, authorization: `Bearer ${call.accessToken}` },
  }).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: { name: call.tool, arguments: call.args },
    }),
  );

  const response = yield* Http.executeRaw(client, request).pipe(
    Effect.mapError(
      (error) =>
        new VisionClient.VisionClientError({
          reason: "unavailable",
          detail: `Vision MCP ${Http.describeTransportError(error)}`,
        }),
    ),
  );

  if (response.status === 401) {
    return yield* new McpUnauthorized({ detail: `HTTP 401${summarizeBody(response.text)}` });
  }
  if (response.status !== 200) {
    return yield* new VisionClient.VisionClientError({
      reason: reasonForStatus(response.status),
      detail: `Vision MCP answered HTTP ${response.status}${summarizeBody(response.text)}`,
    });
  }

  const parsed = yield* decodeJsonRpcResponse(response.text).pipe(
    Effect.mapError(() => protocolError("Vision MCP returned a malformed JSON-RPC response")),
  );
  if ("error" in parsed) {
    return yield* protocolError(
      `Vision MCP JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`,
    );
  }

  const result = parsed.result;
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (result.isError === true) {
    const code = text === undefined ? undefined : decodeToolErrorBody(text);
    if (code !== undefined && code._tag === "Some") {
      return yield* new VisionClient.VisionClientError({
        reason: reasonForToolError(code.value.error),
        detail: `Vision tool ${call.tool} failed with ${code.value.error}`,
      });
    }
    return yield* new VisionClient.VisionClientError({
      reason: "rejected",
      detail: `Vision tool ${call.tool} failed${summarizeBody(text ?? "")}`,
    });
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (text === undefined) {
    return yield* protocolError(`Vision tool ${call.tool} returned no content`);
  }
  return yield* decodeJsonText(text).pipe(
    Effect.mapError(() => protocolError(`Vision tool ${call.tool} returned non-JSON content`)),
  );
});
