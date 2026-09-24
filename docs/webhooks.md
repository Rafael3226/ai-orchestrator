# Webhooks

Push delivery for Trello boards. A card moved into a routed column dispatches in
a couple of seconds instead of waiting out the poll interval.

## How it fits

The receiver **buffers**; the existing `poll()` **drains**. Nothing in
`BoardSync`, `BoardRouter` or `BoardWriter` changes — they still see one ordinary
`BoardSource` (`src/board/board.webhook-buffer.ts` wraps the real one).

Two invariants make that safe:

- **The cursor only ever advances from a real poll.** A delivery carries an
  action id, but not a promise that it is the newest one.
- **The inner `poll()` always runs**, buffer or no buffer.

So Trello's actions feed stays the write-ahead log. A delivery lost to a crash,
an overflow or a 500 is still behind the persisted cursor and comes back on the
next poll. That is why the buffer is in memory and has no table behind it.

**Keep polling on.** Webhooks are at-most-once from our side, and Trello deletes
a webhook that fails persistently. The recommended profile:

```yaml
poll:
  intervalSeconds: 120 # the webhook carries the latency now
  reconcileEveryTicks: 5 # ~10 minutes of wall clock
  reconcileOnStart: true
webhook:
  enabled: true
  deleteOnShutdown: true # dev tunnels only — see below
```

The loader warns (`webhook-redundant-polling`) if you leave the interval under
60s with webhooks on.

## Setup

### 1. Get the API secret

This is the third Trello credential and the one people get wrong. At
<https://trello.com/power-ups/admin>, open your Power-Up → **API key**. The
**secret** shown next to the key is what signs webhooks. It is _not_ the API key
and _not_ your user token.

```sh
TRELLO_MAIN_API_SECRET=<that secret>
ORCHESTRATOR_WEBHOOK_PATH_SECRET=<any unguessable string>
```

### 2. Put a public URL in front

Trello refuses `http://` and anything resolving to localhost, so local
development needs a tunnel.

```sh
# terminal 1 — no account needed
cloudflared tunnel --url http://127.0.0.1:7788
#  → https://random-words-1234.trycloudflare.com

# terminal 2
export ORCHESTRATOR_WEBHOOK_PUBLIC_URL=https://random-words-1234.trycloudflare.com
pnpm orchestrator start
```

`ngrok http 7788` works identically. Any proxy that reformats the JSON body will
break the signature — see triage below.

### 3. Check it

```sh
pnpm orchestrator doctor        # secret set, URL https, tunnel reachable
pnpm orchestrator webhooks list # what Trello thinks is registered
pnpm orchestrator status        # delivered / rejected / dropped counters
```

The daemon registers on start and reconciles on **every** boot, because Trello
may have deleted the registration while you were down. `webhooks register` does
the same thing by hand.

## Why a separate port

The receiver is its own Fastify instance on its own port, not part of the office
server, because:

- `start --no-server` turns the office off; it must never turn dispatch off.
- The office binds loopback and serves a firehose of run logs with
  `Access-Control-Allow-Origin: *`. Two ports means you expose exactly one.
- The office falls back to `index.html` for extensionless paths, so a typo'd
  callback would answer Trello's verification HEAD with `200 text/html` and
  register against a dead route. Here a wrong path 404s.
- Signature checking needs the raw request bytes, and that parser has no
  business touching `/api/*`.

## Echoes

Our own writeback (comment, assign, move, label) comes straight back as
deliveries. They are **buffered but never wake the daemon** — they still have to
reach `BoardRouter`, which is the only thing allowed to decide an event is an
echo, but a run in flight must not storm the loop with its own traffic.

Webhooks actually make the echo guard _safer_: the echo arrives ~0.3s after the
writeback instead of up to a poll interval later, comfortably inside the 15s
`ECHO_WINDOW_MS`.

## Triage

| Symptom                                       | Cause                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `401` in the logs                             | Wrong secret (used the key or token?), or a proxy rewriting the body. The HMAC covers the raw bytes **and** the registered callback URL. |
| `404`                                         | Path secret drift — `ORCHESTRATOR_WEBHOOK_PATH_SECRET` changed since registration. Re-run `webhooks register`.                           |
| `400 board mismatch`                          | The registration points at a different board than `board.boardId`.                                                                       |
| Registration fails with a `callbackURL` error | Trello's verification HEAD did not get a 200. Is the tunnel up and pointing at port 7788?                                                |
| Webhook vanished from `webhooks list`         | Trello deleted it after repeated delivery failures. Restart the daemon; it re-registers.                                                 |
| Nothing delivered, but polling works          | Expected fallback. Check `doctor`'s tunnel probe.                                                                                        |

## Known limits

- `poll` fetches at most 50 actions, so a burst of more than 50 between polls is
  already lossy today. Webhooks make that less likely; reconcile is the backstop.
- The buffer is bounded (`maxBufferedEvents`, default 500). An overflow drops the
  oldest and **forces a reconcile on the next tick**, which is what turns a lost
  delivery back into a dispatch.
