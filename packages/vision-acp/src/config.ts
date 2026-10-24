import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

export const MCP_URL_ENV = "VISION_ACP_MCP_URL";
export const DEFAULT_MCP_PATH = "/mcp";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class VisionConfigError extends Schema.TaggedError<VisionConfigError>()(
  "VisionConfigError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export interface VisionMcpTargetShape {
  /** Full MCP endpoint the bridge posts JSON-RPC to. */
  readonly mcpUrl: URL;
  /** Origin of the Vision deployment; OAuth discovery documents live here. */
  readonly origin: string;
  /** RFC 8707 resource indicator sent on authorize and token requests. */
  readonly resource: string;
}

export class VisionMcpTarget extends Context.Service<VisionMcpTarget, VisionMcpTargetShape>()(
  "@t3tools/vision-acp/config/VisionMcpTarget",
) {}

export const parseMcpUrl = (raw: string): VisionMcpTargetShape | VisionConfigError => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return new VisionConfigError({ detail: `${MCP_URL_ENV} is empty` });
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return new VisionConfigError({ detail: `${MCP_URL_ENV} is not a valid URL` });
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return new VisionConfigError({
      detail: `${MCP_URL_ENV} must use https unless it points at the local machine`,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return new VisionConfigError({ detail: `${MCP_URL_ENV} must be an http(s) URL` });
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = DEFAULT_MCP_PATH;
  }
  url.search = "";
  url.hash = "";
  return { mcpUrl: url, origin: url.origin, resource: url.href };
};

const isConfigError = Schema.is(VisionConfigError);

const fromRaw = (raw: string): Effect.Effect<VisionMcpTargetShape, VisionConfigError> => {
  const parsed = parseMcpUrl(raw);
  return isConfigError(parsed) ? Effect.fail(parsed) : Effect.succeed(parsed);
};

export const layer = (raw: string): Layer.Layer<VisionMcpTarget, VisionConfigError> =>
  Layer.effect(VisionMcpTarget, fromRaw(raw));

export const layerFromEnv: Layer.Layer<VisionMcpTarget, VisionConfigError> = Layer.effect(
  VisionMcpTarget,
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const raw = env[MCP_URL_ENV];
    if (raw === undefined) {
      return yield* new VisionConfigError({ detail: `${MCP_URL_ENV} is not set` });
    }
    return yield* fromRaw(raw);
  }),
);
