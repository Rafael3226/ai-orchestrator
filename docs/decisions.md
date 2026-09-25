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

## Azure DevOps and Jira: State and status as columns, polling first

**Phase 6.** A board column is the Azure DevOps work item **State** and the Jira
issue **status**. Azure DevOps Kanban columns are team-scoped, optional, and
live in a `WEF_*` field whose name differs per team. State is on every process
template and is what every REST client reads, so it is the stable key the
router, the arrival ledger and the dedupe key need. Jira statuses are tracked
by id, so a rename does not re-route anything, and a move runs whichever
workflow transition reaches the target.

_Why polling first._ Neither provider has Trello's board-wide action feed, so
the change feed is synthesized. Azure DevOps runs a WIQL query for changed
items, then reads their revision updates. Jira runs one search with the
changelog expanded. Each poll overlaps the last by two minutes, and the event
store's dedupe on `eventId` makes that overlap free. Webhooks (Azure DevOps
service hooks, Jira webhooks) can later push into the same
`WebhookBufferedSource` the Trello path uses, without changing the cursor
semantics.

_Freeform labels._ Azure DevOps tags and Jira labels need not exist in advance,
so those sources report labels with `id = name`. The writer uses a name that is
not on the board as-is, rather than dead-lettering it.

_Repo host is its own axis._ The board and the pull request host are
independent (`board.provider`, `repo.host.provider`). The publisher talks to a
`PrHost`: `gh` for GitHub, REST for Azure Repos. The Azure Repos PAT reaches git
only as an env-scoped `http.<url>.extraheader`, never argv, so it cannot leak
into a process listing or the repo's config.

## One flow table, derived from routes

**v1.0.** The team became BA → PM → DEV → QA, and a card now has to find its
next owner on success, on failure, when an agent decides it is not theirs, and
when work is created mid-run. The obvious design — a `flow.stages` map of role
to column — would have been a second routing table that drifts from `routes`.

Instead a role's _home column_ is derived at load from its first enabled column
route (plus that route's label). `handTo: <Role>` on a writeback step,
`flow.escalation`, `flow.newItems`, the agent's `reassign` tool and the bounce
cap all resolve through it, so a hand-off always lands exactly where the router
will pick the card up.

_Alternatives rejected._ Letting agents move cards directly would put board
credentials and ordering into the agent's hands; recording requests and
applying them through the outbox after the run keeps the crash-safety and loop
guards the writeback already had, and makes "sub-task before the move that
wakes QA" a matter of queue order.

## DEV-FE and DEV-BE merge into DEV

**v1.0.** The two were deep-equal in every policy; the split existed for
routing by label. One DEV role with the project's own workflow command covers
both, and a project that wants a label-only route still has one.

## The target repo's workflow command is inlined, not executed

**v1.0.** DEV follows `/acts-workflow-managed` from the target repo. Letting the
CLI run it needs `settingSources: ['project']`, which would also load the repo's
hooks and `.mcp.json` into an unattended run. The orchestrator reads the command
(and the commands it references) and inlines it behind fixed overrides: answer
questions by moving forward, and leave tracker, git-remote and PR steps —
including self-approve and merge — to the orchestrator. Nothing merges without
QA and a human.
