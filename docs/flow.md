# Flow

How work moves through the team — **User → BA → PM → DEV → QA → Closed** —
who takes a card when something goes wrong, how any agent creates or hands off
work, and how the orchestrator notices a card that stopped moving.

Everything here is configured per project under `flow:` and the per-role
`writeback`. There is no second routing table: a role's **home column** is the
column of its first enabled column route (plus that route's label, if any), so
handing a card to a role means moving it to exactly where the router will pick
it up again.

```yaml
routes:
  - { when: { column: Requirements }, agent: BA } # BA's home
  - { when: { column: Refinement }, agent: PM } # PM's home
  - { when: { column: Ready }, agent: DEV } # DEV's home
  - { when: { column: Testing }, agent: QA } # QA's home
```

## The happy path

Each role's `onSuccess` names the next role with `handTo`:

```yaml
agents:
  BA: { enabled: true, writeback: { onSuccess: { handTo: PM, comment: report } } }
  PM: { enabled: true, writeback: { onSuccess: { handTo: DEV, comment: report } } }
  DEV: { enabled: true, writeback: { onSuccess: { handTo: QA, comment: report } } }
  QA: { enabled: true, writeback: { onSuccess: { move: done, comment: report } } }
```

`handTo` is an alternative to `move`: set one or the other. The move is ours,
so it wakes the next role through the handoff path (see
`docs/conventions/roles.md`), not through a poll.

| Stage  | Who                              | What lands on the board                                                                                                               |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Intake | the user, in the office **chat** | BA interviews, drafts a story; **Create story** queues it into PM's column (`flow.newItems.story`)                                    |
| Intake | a raw card in `flow.intake`      | a headless BA run refines or splits it                                                                                                |
| BA     | board-only                       | story text, Given/When/Then acceptance criteria, **decisions** (`record_decision` → a _Decisions_ section on the card), extra stories |
| PM     | board-only                       | `set_fields`: priority, story points (Fibonacci), start and due date                                                                  |
| DEV    | draft PR                         | code + tests; `testability` in its summary; a **QA sub-task** with how-to-test steps when testable                                    |
| QA     | draft PR or nothing              | one automated suite per sub-task (Playwright / API e2e preferred); defects as bugs, card back to DEV                                  |

`flow.untestableTo` skips QA: when DEV reports `testability.testable: false`,
a successful DEV run moves the card there instead of handing it to QA.

## When something goes wrong

```yaml
flow:
  humanColumn: blocked
  escalation:
    BA: { onBlocked: human }
    PM: { onBlocked: BA } # can't size it → requirements go back to BA
    DEV: { onFailure: human, onBlocked: PM }
    QA: { onFailure: DEV } # failing tests → back to DEV
  maxBounces: 3
```

- `escalation` sets `handTo` on a role's `onFailure` / `onBlocked` step. It
  replaces the destination of the project-wide default step; a role's own
  writeback overlay that names a `move` or `handTo` still wins.
- `human` means `flow.humanColumn`.
- **Bounce cap.** When a card has already been handed to a role `maxBounces`
  times (counted from the dispatch ledger), the next hand-off to that role goes
  to the human column instead, with the label `ai-loop`. This is what stops a
  DEV ↔ QA ping-pong; the per-role circuit breaker in the router still applies
  on top.

## Agents create and reassign work

Every agent gets board tools, gated per role by `agents.<ROLE>.capabilities`:

| Tool               | Capability         | Default   | Effect                                                                         |
| ------------------ | ------------------ | --------- | ------------------------------------------------------------------------------ |
| `create_work_item` | `create-work-item` | all roles | a story, bug, task, epic, or a sub-task of this card (`parent: current`)       |
| `reassign`         | `reassign`         | all roles | hand **this** card to another role or a human, overriding the normal next step |
| `set_fields`       | `set-fields`       | PM        | priority, story points, start/due dates                                        |
| `add_comment`      | `comment`          | all roles | a note on the card                                                             |
| `list_work_items`  | — (read)           | all roles | this card's sub-tasks, with descriptions                                       |

- Nothing is applied mid-run. The tools record requests; the orchestrator
  applies them through the outbox **after** the run, before the writeback move,
  so a QA sub-task exists before QA is woken. The agent never holds board
  credentials, and a crash loses nothing.
- Requests are validated when made (a sub-task needs a parent; you cannot
  reassign to yourself or to a role with no column), so a mistake round-trips as
  a tool error the agent can fix.
- Who picks up a created item is `assignTo` on the call, else
  `flow.newItems[type]`, else wherever the provider creates it (Jira/ADO: the
  initial state). `none` leaves it there.
- Providers without sub-tasks (Trello) get the sub-task as a comment on the
  parent. Trello stores only the dates natively; priority and points stay in the
  report.

Planning-field ids vary per Jira site; override them under `board.fields`
(`storyPoints`, `startDate`, `dueDate`, `priority`). Issue type names come from
`board.cardTypes` (team-managed Jira uses `subtask: Subtask`).

## DEV's project workflow

`agents.DEV.workflowCommand` (default `/acts-workflow-managed`) names a slash
command in the **target** repo. The orchestrator reads it — from the main
checkout first, because `.claude/` is often gitignored — substitutes the card
key for `$ARGUMENTS`, inlines the commands it references (two levels deep), and
puts it in DEV's prompt behind fixed overrides:

- questions are answered by moving forward (approve / yes), and each assumption
  is recorded as a decision;
- steps that touch the tracker or the remote — transitions, tracker comments,
  branches, commits, pushes, PR create/approve/merge, browsers, `az`/`gh` — are
  skipped: the orchestrator does them, and nothing is ever merged from a run;
- `.claude/config.json` and other credential files are not read.

The target repo's hooks and `.mcp.json` are never loaded (`settingSources: []`).
Set `workflowCommand: false` to turn it off.

## Stale and left-behind work

```yaml
flow:
  closed: done
  stale:
    defaultHours: 48
    columns: { blocked: 24, testing: 24 }
    label: stale
```

Every five minutes the daemon records when each card entered its column
(`card_positions`). A card past its column's threshold, not in `closed`, with
nothing running on it, gets the `stale` label and one comment naming who it is
waiting on (the role whose home the column is, or "a person"). The label is
removed when the card moves.

The office **Attention** panel lists:

- **stale cards**;
- **needs human** — the latest task on a card ended `needs_human`, `blocked`
  or `failed`, nothing has run since, and the card is not sitting in some
  role's column or the closed column (the last 14 days);
- **dead writebacks** — outbox ops that gave up, so the board is out of step.

## The chat

The office has a chat panel per project. It runs a BA agent with read-only
access to the repository and one tool, `propose_story`, which keeps a draft
(story, acceptance criteria, business decisions, open questions) beside the
conversation. **Create story** queues it through the same outbox as any agent
request; the card link appears once the board has it. A conversation is capped
at twice BA's `budget.maxUsd`.
