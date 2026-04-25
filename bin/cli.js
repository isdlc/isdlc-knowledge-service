#!/usr/bin/env node

/**
 * isdlc-knowledge-service CLI entry point.
 *
 * Commands (delegated to src/cli/commands.js):
 *   setup   — Interactive first-time setup (model, Vector DB, ports)
 *   start   — Start API + Worker processes
 *   stop    — Graceful shutdown
 *   status  — Health check, running processes
 *   logs    — Stream stdout logs
 *   reset   — Clear a project's index
 *
 * Traces: T029 — FR-010, FR-012, CON-001
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { registerCommands } from '../src/cli/commands.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

const program = new Command();

program
  .name('isdlc-knowledge')
  .description('iSDLC centralised knowledge service — embedding + Vector DB + MCP')
  .version(pkg.version, '-v, --version', 'Print version');

registerCommands(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
