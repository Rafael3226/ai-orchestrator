# Board and repo providers

Each project picks its **board** and its **repo host** independently:

| Board (`board.provider`) | A card is…  | Its column is…         | Updates arrive by |
| ------------------------ | ----------- | ---------------------- | ----------------- |
| `trello`                 | a card      | its list               | poll or webhook   |
| `azure-devops`           | a work item | its **State**          | poll              |
| `jira`                   | an issue    | its **status** (by id) | poll              |

| Repo host (`repo.host.provider`) | Pull requests via | Push / fetch auth                           |
| -------------------------------- | ----------------- | ------------------------------------------- |
| `github`                         | `gh pr create`    | `gh auth setup-git` (the host's git helper) |
| `azure-devops`                   | Azure Repos REST  | `<REF>_PAT`, injected per git command       |

Any board works with any repo host. `repo.githubRepo: owner/name` is still
accepted as shorthand for `repo.host: { provider: github, githubRepo: owner/name }`.

Secrets live in `.env`, named by the credential ref in the config:

| Provider     | Variables                                                          |
| ------------ | ------------------------------------------------------------------ |
| Trello       | `<REF>_API_KEY`, `<REF>_TOKEN` (+ `<REF>_API_SECRET` for webhooks) |
| Azure DevOps | `<REF>_PAT`                                                        |
| Jira Cloud   | `<REF>_EMAIL`, `<REF>_API_TOKEN`                                   |

One ref can serve an Azure DevOps board and an Azure Repos host together. The
loader rejects one ref claimed by two different providers.

## Setup helpers

```sh
# who the credential writes as → board.botMemberId (the loop guard needs it)
pnpm orchestrator whoami contoso --provider azure-devops --cred ADO_MAIN
pnpm orchestrator whoami acme    --provider jira         --cred JIRA_MAIN

# projects you can see
pnpm orchestrator boards contoso --provider azure-devops --cred ADO_MAIN
pnpm orchestrator boards acme    --provider jira         --cred JIRA_MAIN

# the states / statuses a project has, with ids
pnpm orchestrator lists contoso/Web --provider azure-devops --cred ADO_MAIN
pnpm orchestrator lists acme/SHOP   --provider jira         --cred JIRA_MAIN

# a ready-to-paste board block mapping the existing states to column aliases
pnpm orchestrator init-board contoso/Web --provider azure-devops --cred ADO_MAIN
```

`doctor` calls every configured board and Azure Repos repository live. It checks
that the credential is the configured `botMemberId`, that every `board.columns`
alias exists on the board, and that the base branch exists.

## Azure DevOps Boards

```yaml
board:
  provider: azure-devops
  organization: contoso # dev.azure.com/contoso
  project: Web
  workItemTypes: [User Story, Bug] # default: User Story, Bug, Task
  # areaPath: Web\Team A        # optional UNDER filter
  credentials: ADO_MAIN
  botMemberId: '<identity id from whoami>'
  columns: { ready: Ready, inProgress: Active, review: Resolved, blocked: Blocked }
```

- **Columns are work item States.** Kanban board columns are per-team and
  optional; State is on every process template. The columns are the states of
  the configured work item types, in process order. Add custom states (such as
  _Ready_ or _Blocked_) to the process if your workflow needs them.
- **Moves can fail on process rules.** A state transition the process forbids,
  or one that needs a field the orchestrator does not set, is not retried. The
  outbox dead-letters it with Azure DevOps' own message.
- **Labels are tags**, created on first use. Tag names cannot contain `;`.
- **Descriptions** are HTML in Azure DevOps and reach the agent as markdown.
  Comments are posted as markdown.
- **Assignment** resolves the bot's identity id to its account name, which is
  what `System.AssignedTo` accepts.
- **Polling.** Azure DevOps has no board-wide change feed. Each poll asks WIQL for
  the work items changed since the watermark (minus a two-minute overlap), then
  turns each item's recent revision updates into events. Event ids are
  `ado:<id>:<rev>:<kind>`, so the overlap is deduplicated. Keep
  `poll.intervalSeconds` at 30 or more on a busy project.
- **PAT scopes:** Work Items (Read & write). Add Code (Read & write) if the same
  PAT also serves Azure Repos.

## Jira Cloud

```yaml
board:
  provider: jira
  site: acme # or acme.atlassian.net
  projectKey: SHOP
  # issueTypes: [Story, Bug]
  # jql: component = Backend   # ANDed onto every query
  credentials: JIRA_MAIN
  botMemberId: '<accountId from whoami>'
  columns: { ready: Selected for Development, inProgress: In Progress, review: In Review }
```

- **Columns are statuses**, matched by name in the config but tracked by id.
  Renaming a status therefore does not break routing, as long as `columns`
  follows the rename.
- **A move runs a workflow transition.** The orchestrator picks the transition
  whose target is the requested status. When the workflow has no such
  transition from the current status, the outbox dead-letters the step, naming
  the statuses that _are_ reachable.
- **Labels** are freeform and cannot contain spaces. The loader rejects a
  writeback label that has one.
- **Descriptions and comments** use Atlassian Document Format (ADF). The agent
  reads them as markdown, and reports are written back as ADF.
- **Polling** uses the enhanced search (`/search/jql`) with the changelog
  expanded, over a relative window (`updated >= "-Nm"`). That sidesteps JQL's
  minute-precision, account-timezone dates. Event ids are
  `jira:<issueId>:<historyId>:<kind>`.
- The API token belongs to the account the orchestrator acts as. Use a
  dedicated bot account, so the loop guard can tell its own changes from yours.

## Azure Repos

```yaml
repo:
  path: D:\Repos\contoso\web-shop
  worktreeRoot: D:\aow\web-shop
  host:
    provider: azure-devops
    organization: contoso
    project: Web
    repository: web-shop
    credentials: ADO_MAIN # ADO_MAIN_PAT, Code (Read & write)
```

- **Pull requests** open as drafts (`pr.draft`) through REST. An active PR for
  the branch is reused. Labels are added after creation; a label that fails is
  a warning, not a failed run.
- **Descriptions** are capped at 4000 characters by Azure Repos. A longer report
  is truncated in the PR; the full report is still posted on the card.
- **Work item links.** When the board is Azure DevOps in the same organization,
  the PR is linked to the work item.
- **Git auth.** Push, fetch and `ls-remote` get the PAT as an
  `http.<url>.extraheader`, set through `GIT_CONFIG_*` environment variables
  scoped to `dev.azure.com` and `<org>.visualstudio.com`. It never appears in
  argv, never touches the repo's git config, and never reaches the agent (the
  container env is an allowlist). Without `<REF>_PAT` in the environment, git
  falls back to the host's credential helper.

## Not yet

Webhooks for Azure DevOps (service hooks) and Jira are not implemented. Those
providers poll, and `board.webhook.enabled` is rejected for them at load.
