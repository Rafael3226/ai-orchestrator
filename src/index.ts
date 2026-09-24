#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { Command } from 'commander';

import {
  type BoardCliOptions,
  describeBoard,
  initBoard,
  listBoards,
  showStatus,
  whoAmI,
} from './cli/board.commands.js';
import { runDoctor } from './cli/doctor.js';
import { buildImage, checkImage, pullImage } from './cli/image.js';
import { republish } from './cli/republish.js';
import { runTask } from './cli/run-task.js';
import { runSmoke } from './cli/smoke.js';
import { serveOnly, startDaemon } from './cli/start.js';
import { deleteWebhooks, listWebhooks, registerWebhooks } from './cli/webhook.cli.js';
import { ROLES } from './config/config.schema.js';
import { loadDotEnv } from './config/load-env.js';

loadDotEnv();

const program = new Command()
  .name('orchestrator')
  .description('Board-driven AI dev team: role agents running Claude Code in isolated worktrees')
  .version('0.1.0');

program
  .command('start')
  .description('Run the daemon: poll boards, dispatch agents, write back results, serve the office')
  .option('--no-server', 'do not start the office web server')
  .option('--no-webhook', 'do not start the webhook receiver; poll only')
  .action(async (o: { server: boolean; webhook: boolean }) => {
    process.exitCode = await startDaemon({ noServer: !o.server, noWebhook: !o.webhook });
  });

const image = program
  .command('image')
  .description('Build, verify and pull the container image agents run in');

image
  .command('build')
  .description('Build the agent image, pinning the CLI to the version the SDK bundles')
  .option('--tag <image>', 'override the image tag from the config')
  .option('--cli-version <v>', 'pin a specific @anthropic-ai/claude-code version')
  .action(async (o: { tag?: string; cliVersion?: string }) => {
    process.exitCode = await buildImage(o.tag, o.cliVersion);
  });

image
  .command('check')
  .description("Compare the image's CLI version against the one the SDK bundles")
  .option('--tag <image>', 'check one image instead of every configured one')
  .action(async (o: { tag?: string }) => {
    process.exitCode = await checkImage(o.tag);
  });

image
  .command('pull')
  .description('Pull the configured agent image(s)')
  .option('--tag <image>', 'pull one image instead of every configured one')
  .action(async (o: { tag?: string }) => {
    process.exitCode = await pullImage(o.tag);
  });

const webhooks = program
  .command('webhooks')
  .description('Inspect and manage the board-side push registrations');

webhooks
  .command('list')
  .description('Show every webhook this token owns, and which are ours')
  .option('-p, --project <id>', 'limit to one project')
  .action(async (o: { project?: string }) => {
    process.exitCode = await listWebhooks(o.project);
  });

webhooks
  .command('register')
  .description('Create or refresh the registration for each webhook-enabled project')
  .option('-p, --project <id>', 'limit to one project')
  .option('--url <publicBase>', 'override ORCHESTRATOR_WEBHOOK_PUBLIC_URL')
  .action(async (o: { project?: string; url?: string }) => {
    process.exitCode = await registerWebhooks(o.project, o.url);
  });

webhooks
  .command('delete')
  .description('Remove our registrations (use before abandoning a tunnel URL)')
  .option('-p, --project <id>', 'limit to one project')
  .action(async (o: { project?: string }) => {
    process.exitCode = await deleteWebhooks(o.project);
  });

program
  .command('serve')
  .description('Serve the office UI over the existing database without polling or running agents')
  .action(async () => {
    process.exitCode = await serveOnly();
  });

program
  .command('status')
  .description('Show queue, cursors and outbox from the local database')
  .action(async () => {
    process.exitCode = await showStatus();
  });

program
  .command('republish <taskId>')
  .description(
    'Finish a task whose publish step failed after the push: open the PR, flip to review, write back',
  )
  .action(async (taskId: string) => {
    process.exitCode = await republish(taskId);
  });

program
  .command('doctor')
  .description('Check toolchain, credentials, config, webhooks and target repos')
  .action(async () => {
    process.exitCode = await runDoctor();
  });

const PROVIDER_HELP = 'trello|azure-devops|jira';
const TARGET_HELP = 'Trello board id · Azure DevOps organization/project · Jira site/PROJECTKEY';

program
  .command('boards [target]')
  .description(
    'List Trello boards, or the projects in an Azure DevOps organization / Jira site, plus the bot id',
  )
  .option('-p, --provider <provider>', PROVIDER_HELP, 'trello')
  .option('-c, --cred <ref>', 'credential ref, e.g. TRELLO_MAIN', 'TRELLO_MAIN')
  .action(async (target: string | undefined, o: BoardCliOptions) => {
    process.exitCode = await listBoards(target, o);
  });

program
  .command('lists <target>')
  .alias('columns')
  .description(`Show a board’s columns, labels and members with their ids (${TARGET_HELP})`)
  .option('-p, --provider <provider>', PROVIDER_HELP, 'trello')
  .option('-c, --cred <ref>', 'credential ref', 'TRELLO_MAIN')
  .action(async (target: string, o: BoardCliOptions) => {
    process.exitCode = await describeBoard(target, o);
  });

program
  .command('whoami [target]')
  .description('Print the identity a credential ref writes as: the value for board.botMemberId')
  .option('-p, --provider <provider>', PROVIDER_HELP, 'trello')
  .option('-c, --cred <ref>', 'credential ref', 'TRELLO_MAIN')
  .action(async (target: string | undefined, o: BoardCliOptions) => {
    process.exitCode = await whoAmI(target ?? '_', o);
  });

program
  .command('init-board <name>')
  .description(
    'Trello: create a board with the standard columns and labels. Azure DevOps / Jira: ' +
      'print a board block for <organization/project | site/KEY> mapping its existing states',
  )
  .option('-p, --provider <provider>', PROVIDER_HELP, 'trello')
  .option('-c, --cred <ref>', 'credential ref', 'TRELLO_MAIN')
  .action(async (name: string, o: BoardCliOptions) => {
    process.exitCode = await initBoard(name, o);
  });

program
  .command('smoke')
  .description('Cheap live check of the Agent SDK driver (single turn, no tools)')
  .option('-m, --model <model>', 'model alias or id', 'haiku')
  .option('--cancel <ms>', 'start a long reply and cancel after N ms to test the kill ladder')
  .option('--driver <kind>', 'local|docker — run the turn in a container instead')
  .option('--image <image>', 'image to use with --driver docker')
  .action(async (o: { model: string; cancel?: string; driver?: string; image?: string }) => {
    process.exitCode = await runSmoke({
      model: o.model,
      ...(o.cancel ? { cancelAfterMs: Number(o.cancel) } : {}),
      ...(o.driver === 'docker' ? { driver: 'docker' as const } : {}),
      ...(o.image ? { image: o.image } : {}),
    });
  });

program
  .command('run-task')
  .description('Run one task end to end with no board: worktree → agent → verify → draft PR')
  .requiredOption('-p, --project <id>', 'project id from orchestrator.yaml')
  .option('-r, --role <role>', `agent role (${ROLES.join('|')})`, 'DEV-BE')
  .requiredOption('-t, --title <title>', 'work item title')
  .option('-s, --spec <text>', 'work item description (the spec)')
  .option('-f, --spec-file <path>', 'read the spec from a file')
  .option('--card <shortId>', 'card short id used in the branch name')
  .option('--url <url>', 'card URL for the commit trailer and PR body')
  .option('--label <label...>', 'labels to pass to the agent')
  .option('--dry-run', 'run the agent and verify, but do not commit/push/PR')
  .option('--keep', 'retain the worktree even on success')
  .option('--driver <kind>', "local|docker — override the project's exec.driver")
  .action(
    async (o: {
      project: string;
      role: string;
      title: string;
      spec?: string;
      specFile?: string;
      card?: string;
      url?: string;
      label?: string[];
      dryRun?: boolean;
      driver?: string;
      keep?: boolean;
    }) => {
      const spec = o.specFile ? readFileSync(o.specFile, 'utf8') : (o.spec ?? '');
      process.exitCode = await runTask({
        project: o.project,
        role: o.role as (typeof ROLES)[number],
        title: o.title,
        spec,
        ...(o.card ? { cardShortId: o.card } : {}),
        ...(o.url ? { cardUrl: o.url } : {}),
        ...(o.label ? { labels: o.label } : {}),
        ...(o.dryRun ? { dryRun: true } : {}),
        ...(o.keep ? { keepWorkspace: true } : {}),
        ...(o.driver === 'docker' || o.driver === 'local' ? { driver: o.driver } : {}),
      });
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
