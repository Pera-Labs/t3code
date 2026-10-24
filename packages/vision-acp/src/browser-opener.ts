import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";

export class BrowserOpener extends Context.Service<
  BrowserOpener,
  {
    /**
     * Hands the URL to the owner's default browser. Failures are swallowed on
     * purpose: the URL is always printed to stderr so the owner can open it by hand.
     */
    readonly open: (url: URL) => Effect.Effect<void>;
  }
>()("@t3tools/vision-acp/browser-opener/BrowserOpener") {}

export interface BrowserLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  windowsHide: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const escapePowerShellStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const encodeUtf16LeBase64 = (text: string): string => {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >> 8;
  }
  return Base64.encode(bytes);
};

const resolvePowerShellPath = (env: NodeJS.ProcessEnv): string =>
  `${env.SYSTEMROOT || env.windir || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

export const resolveBrowserLaunch = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  url: URL,
): BrowserLaunch => {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url.href] };
    case "win32":
      return {
        command: resolvePowerShellPath(env),
        args: [
          ...POWERSHELL_ARGUMENTS_PREFIX,
          encodeUtf16LeBase64(
            `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(url.href)}`,
          ),
        ],
      };
    default:
      return { command: "xdg-open", args: [url.href] };
  }
};

export const layerSystem: Layer.Layer<
  BrowserOpener,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  BrowserOpener,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;

    const open = Effect.fn("BrowserOpener.open")(function* (url: URL) {
      yield* Console.error(`vision-acp: approve the bridge in your browser: ${url.href}`);
      const launch = resolveBrowserLaunch(platform, env, url);
      const command = ChildProcess.make(launch.command, launch.args, {
        ...DETACHED_IGNORE_STDIO_OPTIONS,
        env,
        extendEnv: false,
      });
      yield* spawner.spawn(command).pipe(
        Effect.flatMap((handle) => handle.unref),
        Effect.asVoid,
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logDebug("vision-acp: could not launch a browser for the login URL", cause),
        ),
      );
    });

    return { open };
  }),
);

export const layerNoop: Layer.Layer<BrowserOpener> = Layer.succeed(BrowserOpener, {
  open: () => Effect.void,
});
