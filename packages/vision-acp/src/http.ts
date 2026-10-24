import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

export interface RawResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Executes a request and reads the whole body regardless of status, so callers
 * can map non-2xx responses to their own domain errors.
 */
export const executeRaw = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<RawResponse, HttpClientError.HttpClientError> =>
  client.execute(request).pipe(
    Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
      response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((text) => ({ status: response.status, text })),
      ),
    ),
  );

export const describeTransportError = (error: HttpClientError.HttpClientError): string => {
  switch (error.reason._tag) {
    case "TransportError":
      return `network error: ${error.reason.cause instanceof Error ? error.reason.cause.message : String(error.reason.cause)}`;
    case "InvalidUrlError":
      return "invalid URL";
    case "EncodeError":
      return "request body could not be encoded";
    case "DecodeError":
      return "response body could not be decoded";
    case "EmptyBodyError":
      return "empty response body";
    case "StatusCodeError":
      return `unexpected HTTP status ${error.reason.response.status}`;
  }
};
