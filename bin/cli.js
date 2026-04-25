#!/usr/bin/env node

/**
 * isdlc-knowledge-service CLI
 *
 * Commands:
 *   setup   — Interactive first-time setup (model, Vector DB, port)
 *   start   — Start API + Worker processes
 *   stop    — Graceful shutdown
 *   status  — Health check, running processes, memory usage
 *   logs    — Stream stdout logs
 *   reset   — Clear a project's index
 */

import { parseArgs } from 'node:util';

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false
});

const command = positionals[0];

const commands = {
  setup: () => import('../src/cli/setup.js'),
  start: () => import('../src/cli/start.js'),
  stop: () => import('../src/cli/commands.js').then(m => m.stop()),
  status: () => import('../src/cli/commands.js').then(m => m.status()),
  logs: () => import('../src/cli/commands.js').then(m => m.logs()),
  reset: () => import('../src/cli/commands.js').then(m => m.reset(positionals[1]))
};

if (!command || !commands[command]) {
  console.log(`isdlc-knowledge-service v0.1.0-alpha\n`);
  console.log('Usage: isdlc-knowledge <command>\n');
  console.log('Commands:');
  console.log('  setup    Interactive first-time setup');
  console.log('  start    Start API + Worker processes');
  console.log('  stop     Graceful shutdown');
  console.log('  status   Health check and system info');
  console.log('  logs     Stream stdout logs');
  console.log('  reset    Clear a project index (isdlc-knowledge reset <project-id>)');
  process.exit(command ? 1 : 0);
}

commands[command]();
