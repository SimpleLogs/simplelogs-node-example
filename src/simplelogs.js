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
  initOtel,
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

// Tracing is a separate opt-in from logging, and `withTrace` below is what
// needs it: it installs the tracer and the AsyncLocalStorage context manager
// that make a span carry ids and survive an `await`. Skip this and `withTrace`
// still runs your function, but the span it opens is non-recording — every
// entry then has a page and a session and no trace, silently, because a
// process that never opted in is not misconfigured.
//
// After configureSDK, not before: initOtel resolves the OTLP endpoint once,
// from the config as it stands when it runs, and warns if no key is set yet.
// (The credential itself is re-read per export, so a key that arrives later
// does start working — but the endpoint it goes to was already decided.)
//
// `instrumentations: []` because this server continues the caller's trace
// explicitly, in withRequest below. The automatic alternative is
// `@opentelemetry/instrumentation-http`, an extra dependency that patches
// `node:http` at require time — worth it when the wiring is not yours to
// change, and not worth it here, where it is.
initOtel({ instrumentations: [] });

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
  // Page and session ids only — the trace itself rides `traceparent` and is
  // handled by `withTrace` below, so nothing here reads a trace id.
  const correlation = resolveCorrelationOverride({ requestHeaders: req.headers }) ?? {};
  const key = randomUUID();

  return requestScope.run(correlation, () =>
    // Seeds this request's spans with the browser trace that fired the fetch,
    // so the server work joins the page's tree instead of a detached one. A
    // caller that sends no `traceparent` — curl, another service — opens its
    // own trace here instead. withTrace also isolates concurrent requests from
    // each other, so two in flight at once never land in each other's traces.
    // Both of those depend on initOtel() above having run.
    //
    // The headers go in whole, as a `carrier`. The trace now travels as W3C
    // `traceparent` rather than the SDK's own `x-simplelogs-trace-id` pair, and
    // `withTrace` does the extracting — so this hands it the request's headers
    // rather than picking ids out of them first.
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
      { carrier: req.headers },
    ),
  );
}
