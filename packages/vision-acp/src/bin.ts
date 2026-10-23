import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AcpAgent from "effect-acp/agent";

import * as VisionAcp from "./agent.ts";
import * as VisionClient from "./vision-client.ts";

// Vision must never be driven from inside a Vision-driven session, so the
// bridge marks its own environment and refuses to start when the mark is set.
const RECURSION_GUARD = "VISION_ACP_BRIDGE";

if (process.env[RECURSION_GUARD] === "1") {
  process.stderr.write(`${VisionAcp.AGENT_NAME}: refusing to start inside another Vision bridge\n`);
  process.exit(2);
}
process.env[RECURSION_GUARD] = "1";

const MainLayer = Layer.mergeAll(
  VisionClient.layerUnavailable,
  Layer.provide(AcpAgent.layerStdio(), NodeServices.layer),
);

VisionAcp.register().pipe(
  Effect.andThen(Effect.never),
  Effect.scoped,
  Effect.provide(MainLayer),
  NodeRuntime.runMain,
);
