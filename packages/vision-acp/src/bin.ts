import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as AcpAgent from "effect-acp/agent";

import * as VisionAcp from "./agent.ts";
import * as BrowserOpener from "./browser-opener.ts";
import * as Config from "./config.ts";
import * as OwnerAuth from "./oauth.ts";
import * as TokenStore from "./token-store.ts";
import * as VisionClient from "./vision-client.ts";
import * as VisionClientLive from "./vision-client-live.ts";

// Vision must never be driven from inside a Vision-driven session, so the
// bridge marks its own environment and refuses to start when the mark is set.
const RECURSION_GUARD = "VISION_ACP_BRIDGE";

if (process.env[RECURSION_GUARD] === "1") {
  process.stderr.write(`${VisionAcp.AGENT_NAME}: refusing to start inside another Vision bridge\n`);
  process.exit(2);
}
process.env[RECURSION_GUARD] = "1";

const mcpUrl = process.env[Config.MCP_URL_ENV];

// Without a configured endpoint the bridge still speaks ACP so the client can
// show the setup hint, but every prompt answers with the unavailable explanation.
const VisionLayer: Layer.Layer<
  VisionClient.VisionClient | OwnerAuth.OwnerAuth,
  Config.VisionConfigError
> =
  mcpUrl === undefined || mcpUrl.trim() === ""
    ? Layer.mergeAll(VisionClient.layerUnavailable, OwnerAuth.layerUnavailable)
    : VisionClientLive.layer.pipe(
        Layer.provideMerge(OwnerAuth.layer),
        Layer.provide(
          Layer.mergeAll(
            Config.layer(mcpUrl),
            TokenStore.layerFile,
            BrowserOpener.layerSystem,
            NodeHttpClient.layerUndici,
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

// stdout carries the ACP stream, so every log line has to go to stderr.
const MainLayer = Layer.mergeAll(
  VisionLayer,
  Layer.provide(AcpAgent.layerStdio(), NodeServices.layer),
  Layer.succeed(Logger.LogToStderr, true),
);

VisionAcp.register().pipe(
  Effect.andThen(Effect.never),
  Effect.scoped,
  Effect.provide(MainLayer),
  NodeRuntime.runMain,
);
