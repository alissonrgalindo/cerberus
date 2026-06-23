#!/usr/bin/env node
// Claude Code PreToolUse(Bash) entrypoint for plugin.json registration.
// Forwards the hook payload (stdin) to `cerberus claude-hook`, which
// blocks the commit (exit 2) when the gate fails.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const input = readFileSync(0);
const result = spawnSync('node', [cli, 'claude-hook'], { input, stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 0);
