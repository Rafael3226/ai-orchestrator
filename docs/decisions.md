# Decisions

The short version of each architectural call, and the reasoning that would
otherwise have to be reconstructed from the code. Newest last.

## Roles differ by a delivery policy, not by branching in the runner

**Phase 5.** Four places assumed every role produced code: `propose_summary`
required a Conventional Commit, `publish()` always committed and opened a PR, an
empty diff aborted with `nothing-to-commit`, and the runner mapped that abort to
`failed`. A PM that wrote a good spec and a QA that correctly found nothing to
change therefore both ended as failures.

`ROLE_DELIVERY` (`src/policy/delivery.policy.ts`) is one frozen table declaring,
per role: pull request or board-only, whether an empty diff is a failure, what it
verifies with, whether it installs, whether it must commit, and which paths it
may write. The runner, the publisher, the prompts and the report builder all read
it.

_Alternatives rejected._ A second MCP tool for board-only summaries would have
touched `ScriptedDriver`, the board server and the office log renderer, for the
sake of a field that is optional anyway. Per-project YAML overrides of the policy
would make "what does QA do here" unanswerable without opening a config.

_Consequence._ Adding a code-producing role is config plus a charter; the test
asserting `DEV-FE` deep-equals `DEV-BE` is what keeps that honest.

## Handoff bypasses the echo guard, deliberately and locally

**Phase 5.** One role finishing should be able to wake the next, but the move
that would trigger it is _ours_, so the loop guard drops it, and reconcile skips
any card that already has a ledger row. Both are correct in general.

`BoardWriter` therefore calls `onMoved` when one of our moves settles, and
`BoardSync.handoff` re-routes that one card with `handoff: true`, which is
honoured at exactly those two sites and nowhere else.

_What keeps it from looping._ The arrival counter is re-recorded before routing,
so the dedupe key differs from the previous dispatch; the circuit breaker counts
per role rather than per card; the loader rejects, at load time, any role whose
writeback lands the card in a column routed back to itself; and a handoff is
skipped while any task for that card is still in flight.

## The webhook receiver buffers; `poll()` drains

**Phase 5**, and pre-committed to by `board.source.ts` since phase 3.

Two invariants make it safe: the cursor **never** comes from the buffer, and the
inner `poll()` **always** runs. Together they keep the provider's change feed as
the write-ahead log, so a delivery lost to a crash, an overflow or a 500 is still
behind the persisted cursor and comes back on the next poll.

_Consequence._ The buffer is a latency cache with no table behind it. Persisting
it would create a second durable log that can disagree with the cursor, with its
own recovery and compaction to get wrong.

_Why polling stays on._ Webhooks are at-most-once from our side, and Trello
deletes a webhook that fails persistently. The poller drops to ~120s and becomes
the reconcile safety net.

_Why a separate Fastify instance._ `start --no-server` must not disable dispatch;
the office binds loopback and serves run logs with `ACAO: *`; the office's SPA
fallback would answer Trello's verification HEAD with `200 text/html` on a
typo'd path; and raw-body parsing has no business changing `/api/*`.

## Docker: host-side SDK client, container-side CLI

**Phase 5.** The board MCP server and the PreToolUse guards are plain JS objects
handed to the SDK and driven over its stdio control protocol — they are never
serialized. So the SDK client stays in the orchestrator process and only the
`claude` CLI moves into the container, bridged by `docker run -i` through
`Options.spawnClaudeCodeProcess`.

_Alternatives rejected._ Containerizing only tool execution has no seam:
`canUseTool` can approve or deny a call, not redirect where it runs, so Bash,
Edit and Read would have to be reimplemented as MCP tools. Moving the SDK client
into the container would need an RPC surface and an auth story for `SqliteStore`,
would turn the hooks into CLI hook commands (re-enabling a settings source we
deliberately zeroed), and would drag `gh` and the board token inside.

_Accepted costs._ `Options.stderr` is dead under a custom spawner, so the driver
pumps container stderr itself; the image's CLI version can drift from the SDK's
bundled one, so it is pinned and checked; and the container protects the **host**
from the agent, not the orchestrator — this is a blast-radius boundary, not a
security milestone.

_The load-bearing detail._ A worktree's `.git` is a file pointing at the parent
repo, so the parent `.git` is mounted at `/gitcommon` and git is pinned with
`GIT_DIR`/`GIT_WORK_TREE`. That file is never rewritten, because the host
publisher reads it moments later to stage, commit and push.

_Why install and verify moved into the container too._ Not speed — a host
`pnpm install` produces win32 native binaries a Linux container cannot load.
