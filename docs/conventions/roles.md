# Roles

Five roles share one pipeline. What differs between them is declared once, in
`src/policy/delivery.policy.ts`, and everything downstream reads it.

| Role   | Outcome      | Empty diff  | Verifies with     | Installs | Commit | May write                  |
| ------ | ------------ | ----------- | ----------------- | -------- | ------ | -------------------------- |
| DEV-BE | pull request | failure     | `checks.test`     | yes      | yes    | anywhere in the worktree   |
| DEV-FE | pull request | failure     | `checks.test`     | yes      | yes    | anywhere in the worktree   |
| DEVOPS | pull request | failure     | `checks.infra` \* | yes      | yes    | CI, Docker, infra, scripts |
| QA     | pull request | **success** | `checks.test`     | yes      | yes    | tests only                 |
| PM     | board only   | n/a         | nothing           | **no**   | **no** | nothing                    |

\* falls back to `checks.test` when the project declares no `infra` check.

## Why this table exists

The pipeline used to assume every role produced code. `propose_summary` required
a Conventional Commit, `publish()` always committed and opened a PR, and an empty
diff aborted with `nothing-to-commit`, which the runner mapped to `failed`.

So a PM that wrote a perfect specification, and a QA that reviewed a branch and
correctly found nothing to change, both ended up marked **failed**. The delivery
policy is what makes those outcomes representable.

## The three interesting rows

**DEV-FE is deep-equal to DEV-BE.** A second code-producing role costs a charter
and a route, not pipeline code. `delivery.policy.test.ts` asserts the equality, so
if they ever diverge it is on purpose.

**QA is adaptive** (`diff: 'optional'`). Wrote a missing test → an ordinary draft
PR. Reviewed and found only issues → no commit, no branch push, no PR; the
findings go on the card and the verdict is still `review`.

**PM never touches git** (`kind: 'board-only'`). No `pnpm install`, no verify, no
branch diff, no PR. The body of its `propose_summary` _is_ the deliverable and is
posted to the card verbatim, along with `acceptanceCriteria` as a checklist.

## Write confinement

`writeGlobs` narrows a role to part of the tree. It is enforced in
`src/policy/path.guard.ts` by the same PreToolUse hook that already enforces
worktree containment, so a write outside the allowlist is denied before it
happens and shows up in the run's _Guard denials_ section.

The `FORBIDDEN_WRITE` list (`.git`, `.env`, `node_modules`, `.husky`, Claude
settings, `.mcp.json`) still wins over any allowlist.

## Writeback is per role

`projects[].writeback` is the project default; `projects[].agents.<ROLE>.writeback`
overlays it per step. This is required, not a nicety: QA is routed on **In
Review**, so inheriting the project's `onSuccess: { move: review }` would move the
card straight back into its own trigger column. The loader rejects exactly that
shape at load time.

```yaml
agents:
  QA:
    enabled: true
    writeback:
      onSuccess: { move: done, comment: report, addLabel: qa-passed }
      onFailure: { move: ready, comment: report, addLabel: qa-findings }
```

## Handoff

A role finishing can wake the next one. When one of _our_ moves settles,
`BoardWriter` calls `onMoved`, and `BoardSync.handoff` re-routes that card with
`handoff: true`.

That flag deliberately bypasses two guards — the echo window (the move is ours,
so an ordinary poll would drop it) and the reconcile ledger check (the card
already has a row). Three things keep it from looping:

- the arrival counter in the dedupe key, re-recorded before routing;
- the circuit breaker, which counts **per role**, so PM → DEV → QA is fine but one
  role dispatching repeatedly is not;
- the load-time diagnostic that rejects a role whose writeback lands the card in
  a column routed back to itself.

A handoff is also skipped while any task for that card is still in flight, which
matches the `ux_one_active_task_per_card` index.

## Not in scope

- **PM creating cards.** It refines the card it was given. Creating new ones needs
  a `propose_cards` tool, a `create-card` outbox op and `BoardSource.createCard`.
- **DEVOPS running infrastructure.** `docker`, `terraform` and `kubectl` stay
  denied by `bash.guard.ts`. DEVOPS edits configuration and explains the rollout.
- **Per-project delivery overrides.** `ROLE_DELIVERY` is code, not YAML. A project
  that needs a different contract is a signal to add a role, not a knob.
