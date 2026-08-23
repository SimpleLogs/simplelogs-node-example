# SimpleLogs + Node

A framework-free Node server instrumented with
[`@simplelogs/node`](https://www.npmjs.com/package/@simplelogs/node) — plain
`node:http`, no Express, no React, no rrweb.

**If you use Express, use
[`@simplelogs/express`](https://github.com/SimpleLogs/simplelogs-express-example)
instead** — it is two middleware mounts and you write none of the wiring below.
This repo is for Fastify, Koa, Hono, a worker, a cron job, or anything else
that has no ready-made binding.

## Setup

You need a **server key** — SimpleLogs dashboard → **Settings → API Keys**.

```bash
cp .env.example .env     # paste your server key into SIMPLELOGS_SERVER_KEY
npm install
npm start                # http://localhost:3200
```

Requires Node 22 or newer (`--env-file-if-exists` loads `.env` with no `dotenv`
dependency). `npm run dev` restarts on change.

Then exercise it:

```bash
curl localhost:3200/orders/42
curl -X POST localhost:3200/checkout
curl localhost:3200/reports/revenue
curl localhost:3200/boom
```

## The integration

All of it is in [`src/simplelogs.js`](src/simplelogs.js) — about 50 lines you
can copy into your own project. [`src/server.js`](src/server.js) is just an app
for it to instrument.

There are three parts.

**1. Configure once, at startup.**

```js
import { configureSDK } from "@simplelogs/node";

configureSDK({ serverKey: process.env.SIMPLELOGS_SERVER_KEY });
```

**2. Give the SDK a request scope.**

```js
import { AsyncLocalStorage } from "node:async_hooks";
import { setAmbientCorrelationSource } from "@simplelogs/node";

const requestScope = new AsyncLocalStorage();
setAmbientCorrelationSource(() => requestScope.getStore());
```

This is the step Next.js gets for free through `next/headers`, and the one a
long-lived Node process has to build. It is what lets `serverLogger.log()` deep
inside a handler pick up the caller's page and session ids without every call
site threading `req` down to it.

Register the reader **once**, at module load. Re-registering per request would
race concurrent requests through a single module-level slot.

**3. Open the scope around each request.**

```js
import { resolveCorrelationOverride, withTrace } from "@simplelogs/node";

const correlation = resolveCorrelationOverride({ requestHeaders: req.headers }) ?? {};

requestScope.run(correlation, () =>
  withTrace(handler, {
    traceId: correlation.traceId,
    parentSpanId: correlation.parentSpanId,
  }),
);
```

`resolveCorrelationOverride()` pulls the ids the browser SDK's patched `fetch`
forwards on same-origin requests, so you never name the headers yourself. A
call from curl or another server simply has none and starts its own trace.

`withTrace()` seeds this request's spans with the browser trace that fired the
fetch, so the server work joins the page's tree instead of a detached one. It
also isolates concurrent requests from each other — something a long-lived
process needs and a per-invocation serverless one does not.

## Logging and timing

```js
import { serverLogger } from "@simplelogs/node";

await serverLogger.log({ touchpoint: "checkout/submit", level: "info" });

await serverLogger.start({ key, touchpoint: "reports/revenue/query" });
await serverLogger.end({ key, metadata: { rowCount: rows.length } });
```

`start()` and `end()` match on `key`, so operations that overlap stay separate
timings rather than one wrong one.

`start()` resolves correlation before it reaches the queue, so it is genuinely
async — **await it**. An `end()` that lands before its `start()` is dropped.

### Naming

`touchpoint` is what the dashboard aggregates on, so keep it stable:
`orders/[id]`, never `orders/42`. A touchpoint per order id would make
percentiles meaningless. [`src/server.js`](src/server.js) declares the name
next to each route rather than deriving it from `req.url`, which is what keeps
the id out of it.

## Skipping the boilerplate

If you don't need correlation with a browser — a cron job, a queue worker, a
CLI — steps 2 and 3 are optional. `configureSDK()` plus `serverLogger` is a
complete integration on its own.

You can also pass the headers per call instead of opening a scope:

```js
await serverLogger.log({ touchpoint: "job/run", requestHeaders: req.headers });
```

That works, but every call site then needs `req`, which is the problem the
request scope exists to solve.

## What this server demonstrates

| Route | Shows |
|---|---|
| `GET /orders/:id` | A request timed with no logging code in the handler |
| `POST /checkout` | `serverLogger.log()` with no `req` argument — the scope supplies the ids |
| `GET /reports/revenue` | `start()` / `end()` timing a sub-operation inside the request |
| `GET /boom` | An error logged at `error` level, then re-raised |
| `GET /healthz` | Answered before the wrapper, so probes do not swamp the data |

## Shutting down

Entries are batched. The SDK flushes on `beforeExit`, but a container killed
with `SIGTERM` never reaches that — deliberately, since a library that installs
a signal handler would suppress Node's default termination and hang containers
that expect to die on a signal.

The end of [`src/server.js`](src/server.js) shows the explicit `flushServer()`
in your own handler.

## Which key goes here

The **server** key, and only ever that one. It is secret, it stays on the
server, and `.env` is gitignored so it is not committed. The client key is a
different value, for browsers.

## Other examples

| Your app | Example | Package |
|---|---|---|
| Node, any server framework | **this repo** | `@simplelogs/node` |
| Express | [simplelogs-express-example](https://github.com/SimpleLogs/simplelogs-express-example) | `@simplelogs/express` |
| Plain HTML / any framework | [simplelogs-vanilla-example](https://github.com/SimpleLogs/simplelogs-vanilla-example) | `@simplelogs/browser` |
| React (Vite, CRA, Remix, React Router) | [simplelogs-react-example](https://github.com/SimpleLogs/simplelogs-react-example) | `@simplelogs/react` |
| Next.js | [simplelogs-next-example](https://github.com/SimpleLogs/simplelogs-next-example) | `@simplelogs/next` |

Frontend and backend packages are complementary, not alternatives — a browser
app talking to this server installs `@simplelogs/browser` or
`@simplelogs/react` on its side, and the two correlate automatically.
