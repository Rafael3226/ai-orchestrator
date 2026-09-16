#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { Command } from 'commander';

import { describeBoard, initBoard, listBoards, showStatus } from './cli/board.commands.js';
import { runDoctor } from './cli/doctor.js';
import { runTask } from './cli/run-task.js';
import { runSmoke } from './cli/smoke.js';
import { serveOnly, startDaemon } from './cli/start.js';
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
  .action(async (o: { server: boolean }) => {
    process.exitCode = await startDaemon({ noServer: !o.server });
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
  .command('doctor')
  .description('Check toolchain, credentials, config and target repos')
  .action(() => {
    process.exitCode = runDoctor();
  });

program
  .command('boards')
  .description('List Trello boards visible to a credential ref (and the bot member id)')
  .option('-c, --cred <ref>', 'credential ref, e.g. TRELLO_MAIN', 'TRELLO_MAIN')
  .action(async (o: { cred: string }) => {
    process.exitCode = await listBoards(o.cred);
  });

program
  .command('lists <boardId>')
  .description('Show a board’s columns, labels and members with their ids')
  .option('-c, --cred <ref>', 'credential ref', 'TRELLO_MAIN')
  .action(async (boardId: string, o: { cred: string }) => {
    process.exitCode = await describeBoard(boardId, o.cred);
  });

program
  .command('init-board <name>')
  .description('Create a Trello board with the standard columns and labels (writes to Trello)')
  .option('-c, --cred <ref>', 'credential ref', 'TRELLO_MAIN')
  .action(async (name: string, o: { cred: string }) => {
    process.exitCode = await initBoard(name, o.cred);
  });

program
  .command('smoke')
  .description('Cheap live check of the Agent SDK driver (single turn, no tools)')
  .option('-m, --model <model>', 'model alias or id', 'haiku')
  .option('--cancel <ms>', 'start a long reply and cancel after N ms to test the kill ladder')
  .action(async (o: { model: string; cancel?: string }) => {
    process.exitCode = await runSmoke({
      model: o.model,
      ...(o.cancel ? { cancelAfterMs: Number(o.cancel) } : {}),
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
      });
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
