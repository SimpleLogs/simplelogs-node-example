/**
 * A framework-free Node server. The instrumentation lives in
 * ./simplelogs.js — this file is just something for it to instrument.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { serverLogger, flushServer } from "@simplelogs/node";
import { withRequest } from "./simplelogs.js";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// Routes are declared with the touchpoint they aggregate under, so the id in
// /orders/42 never reaches the name. That masking is the whole reason to
// declare the name rather than derive it from req.url.
const routes = [
  {
    method: "GET",
    match: /^\/orders\/[^/]+$/,
    touchpoint: "orders/[id]",
    // No logging code at all. withRequest() already timed this.
    handler: (req, res) =>
      json(res, 200, { id: req.url.split("/").pop(), status: "shipped" }),
  },
  {
    method: "POST",
    match: /^\/checkout$/,
    touchpoint: "checkout/submit",
    // Note there is no `req` argument on the log call. The request scope
    // opened by withRequest() makes the caller's ids ambient, so this line
    // correlates to the browser session that caused it.
    handler: async (_req, res) => {
      await serverLogger.log({
        touchpoint: "checkout/submit",
        level: "info",
        message: "Checkout started",
      });
      json(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    match: /^\/reports\/revenue$/,
    touchpoint: "reports/revenue",
    // A timing nested inside the request's own. start() and end() match on
    // `key`, so overlapping operations stay separate, and the dashboard shows
    // how much of the response time the query accounted for.
    handler: async (_req, res) => {
      // randomUUID, not Date.now(): start/end are matched through a map on a
      // process-wide queue, so two requests in the same millisecond would
      // share a timestamp key and cross each other's pairs.
      const key = `revenue-${randomUUID()}`;
      await serverLogger.start({ key, touchpoint: "reports/revenue/query" });

      try {
        const rows = await new Promise((resolve) =>
          setTimeout(() => resolve([{ total: 4200 }]), 120),
        );
        json(res, 200, rows);
      } finally {
        // In a finally: a query that throws is the one most worth timing, and
        // a start that never closes records nothing at all.
        await serverLogger.end({ key });
      }
    },
  },
  {
    method: "GET",
    match: /^\/boom$/,
    touchpoint: "boom",
    handler: () => {
      throw new Error("Something broke in the example");
    },
  },
];

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];

  // Health checks would otherwise dominate the timing data, so this one is
  // answered before the instrumentation wrapper.
  if (path === "/healthz") return json(res, 200, { ok: true });

  const route = routes.find((r) => r.method === req.method && r.match.test(path));
  if (!route) return json(res, 404, { error: "Not found" });

  try {
    await withRequest({ req, res, touchpoint: route.touchpoint }, () =>
      route.handler(req, res),
    );
  } catch (error) {
    // withRequest() already logged this at level "error" and re-raised it, so
    // your own error handling is unchanged.
    json(res, 500, { error: error.message });
  }
});

const port = process.env.PORT ?? 3200;
server.listen(port, () => console.log(`Example server on http://localhost:${port}`));

// Entries are batched, so a process that exits mid-batch drops them. The SDK
// flushes on `beforeExit` by itself, but a container killed with SIGTERM never
// reaches that — hence the explicit flush.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(async () => {
      await flushServer();
      process.exit(0);
    });
  });
}
