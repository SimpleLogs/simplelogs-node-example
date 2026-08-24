/**
 * The whole integration, in one file you can copy into your own project.
 *
 * `@simplelogs/node` knows nothing about your HTTP framework. It gives you a
 * logger and the pieces to hand it a request scope; this file wires those to a
 * plain `node:http` server. `@simplelogs/express` is this same file, packaged.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  configureSDK,
  serverLogger,
  setAmbientCorrelationSource,
  resolveCorrelationOverride,
  withTrace,
} from "@simplelogs/node";

// --- 1. Configure once, at startup ------------------------------------------
configureSDK({
  serverKey: process.env.SIMPLELOGS_SERVER_KEY,
  environment: process.env.NODE_ENV ?? "development",
});

// --- 2. Give the SDK a request scope ----------------------------------------
// A long-lived process has to supply this scope itself, and AsyncLocalStorage
// is how: it is what lets `serverLogger.log()` deep inside a handler pick up
// the caller's page and session ids without every call site threading `req`
// down to it.
//
// Register the reader once. Re-registering per request would race concurrent
// requests through this single module-level slot.
const requestScope = new AsyncLocalStorage();
setAmbientCorrelationSource(() => requestScope.getStore());

/**
 * Runs `handler` inside a scope for this request, and records a timing for it.
 *
 * `touchpoint` is the name the request aggregates under. Keep it stable —
 * `orders/[id]`, not `orders/42` — or percentiles stop meaning anything.
 */
export function withRequest({ req, res, touchpoint }, handler) {
  // The ids the browser SDK's patched `fetch` forwards on same-origin
  // requests. A call from curl or another server simply has none, and starts
  // its own trace instead.
  const correlation = resolveCorrelationOverride({ requestHeaders: req.headers }) ?? {};
  const key = randomUUID();

  return requestScope.run(correlation, () =>
    // Seeds this request's spans with the browser trace that fired the fetch,
    // so the server work joins the page's tree instead of a detached one.
    // withTrace also isolates concurrent requests from each other, so two in
    // flight at once never land in each other's traces.
    withTrace(
      async () => {
        // Await it. start() resolves correlation before it reaches the
        // queue, so it is genuinely async, and the request's span is not open
        // until it resolves — anything the handler times before that would be
        // recorded beside the request rather than inside it.
        await serverLogger.start({
          key,
          standalone: true,
          touchpoint,
          metadata: { method: req.method, path: req.url },
        });

        // The status is only final once the response has been written, which
        // is after your error handling runs — not when the handler returns.
        // Closing the timing here rather than in a `finally` is what keeps a
        // request that failed from being recorded as a 200.
        //
        // "close" fires on a completed response and on a connection dropped
        // early, so no request goes untimed. start() and end() match on `key`.
        res.once("close", () => {
          void serverLogger.end({ key, metadata: { status: res.statusCode } });
        });

        try {
          await handler();
        } catch (error) {
          // Log it and re-raise. The SDK never swallows an error — your own
          // handling still runs exactly as it did before.
          await serverLogger.log({
            touchpoint,
            level: "error",
            message: error.message,
            metadata: { stack: error.stack },
          });
          throw error;
        }
      },
      { traceId: correlation.traceId, parentSpanId: correlation.parentSpanId },
    ),
  );
}
