# Working in simplelogs-node-example

This repo demonstrates `@simplelogs/node` on a plain `node:http` server, with
no framework and no browser half. The integration is `src/simplelogs.js`;
`src/server.js` is the app it instruments.

It is one of five standalone examples, one per installable SDK package:

| Example | Package | Port |
|---|---|---|
| vanilla | `@simplelogs/browser` | 5173 |
| react | `@simplelogs/react` | 5174 |
| next | `@simplelogs/next` | 5175 |
| express | `@simplelogs/express` | 3100 |
| node (this repo) | `@simplelogs/node` | 3200 |

## House style

The five examples share one style, so keep it:

- npm, not pnpm.
- Plain JS: no TypeScript, Tailwind or ESLint.
- No `dotenv`. In this repo, Node's `--env-file-if-exists=.env` in the
  `start` and `dev` scripts loads `.env`.
- A `.env.example` with the SimpleLogs variables a user sets.
- A README covering setup, key handling and the reasoning behind each choice,
  ending in a cross-link table to the other examples.

## Dependencies

- Never use a `file:` or absolute-path dependency.
- Pin `@simplelogs/*` only to versions npm publishes. Check with
  `npm view @simplelogs/node versions`.

## Environment variables

The app code reads three variables:

- `SIMPLELOGS_SERVER_KEY`: the secret server key, passed to `configureSDK()`.
- `NODE_ENV`: passed to `configureSDK()` as `environment`, defaulting to
  `development`.
- `PORT`: the port the server listens on, defaulting to 3200.

The SDK itself also reads `SIMPLELOGS_*` variables from `process.env`. The
one this repo documents in `.env.example` is `SIMPLELOGS_API_ENDPOINT`, the
collector base URL. On the server, the SDK takes it only from the
environment.

With `initOtel()` running (as shipped), logs and timings go over OTLP. The
SDK derives the OTLP base by replacing a trailing `/api/v1` with `/api/otlp`,
or by appending `/api/otlp` to an endpoint that doesn't end in `/api/v1`. It
then posts to `/v1/logs`, `/v1/traces` and `/v1/metrics` under that base.
Without `initOtel()`, log and timing batches go as JSON to
`<endpoint>/enqueue` instead. So `http://localhost:4999/api/v1` receives
`/api/otlp/v1/logs` and `/api/otlp/v1/traces` as shipped, and
`/api/v1/enqueue` without OTel.

`.env` is gitignored. Never commit a real key.

## Verifying a change

1. `npm install`.
2. Start a stand-in collector: a small `node:http` server that prints the
   path and body of every POST and answers `200 {}`. The `/otlp/` bodies are
   protobuf, so decode them if you need trace and span ids.
3. Boot the server against it:

   ```bash
   SIMPLELOGS_SERVER_KEY=sk_test SIMPLELOGS_API_ENDPOINT=http://localhost:4999/api/v1 npm start
   ```

   Startup takes a few seconds, so wait for `Example server on
   http://localhost:3200` before sending requests.
4. Exercise the routes with `curl` (see the README), then stop the server
   with `SIGTERM` or Ctrl-C so it flushes.

Never truncate the collector's log, or write to it from another process,
while the collector holds the file open.

## Tracing behavior

What the collector shows for the code as it stands:

- With `initOtel()` running (as shipped), `withTrace()` opens one span per
  request. A `serverLogger.log()` inside the handler is sent over OTLP with
  that span's trace and span ids. If the request carries a `traceparent`, the
  span joins that trace as a child of the caller's span. Without one, it
  starts a new trace.
- Without `initOtel()`, nothing goes over OTLP. Logs and timings go as JSON to
  `/api/v1/enqueue` with no trace or span ids, whether or not the request
  carries a `traceparent`.
- Timings don't nest inside each other. Each `serverLogger.start()` span is
  parented under the active context, which is the `withTrace()` span, and
  `start()` doesn't make its own span active. So in `GET /reports/revenue`,
  the `reports/revenue/query` timing and the `reports/revenue` request timing
  are siblings under the `withTrace()` span. This is the same whether or not
  `withRequest()` awaits `start()`.

## Docs style

Docs and comments describe current behavior only, in US English.
