import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from './defaults.js';
import monorepoPreset from './presets/monorepo-turborepo.json';
import nextjsPreset from './presets/nextjs.json';
import nodeCliPreset from './presets/node-cli.json';
import type { Config } from './types.js';

type PartialConfig = Partial<Config> & { extends?: string };

/**
 * Internal presets resolvable via `extends`.
 * `@cerberus/*` is the canonical scope; `@quality-gate/*` is kept as a
 * backward-compatible alias so existing consumer configs keep working.
 */
const PRESETS: Record<string, PartialConfig> = {
  '@cerberus/nextjs': nextjsPreset as PartialConfig,
  '@quality-gate/nextjs': nextjsPreset as PartialConfig,
  nextjs: nextjsPreset as PartialConfig,
  '@cerberus/node-cli': nodeCliPreset as PartialConfig,
  '@quality-gate/node-cli': nodeCliPreset as PartialConfig,
  'node-cli': nodeCliPreset as PartialConfig,
  '@cerberus/monorepo-turborepo': monorepoPreset as PartialConfig,
  '@quality-gate/monorepo-turborepo': monorepoPreset as PartialConfig,
  'monorepo-turborepo': monorepoPreset as PartialConfig,
};

/** Canonical config file. */
export const CONFIG_FILE = '.cerberus.json';
/** Legacy config file, still honored when `.cerberus.json` is absent. */
export const LEGACY_CONFIG_FILE = '.quality-gate.json';

function merge(base: Config, over: PartialConfig): Config {
  return {
    thresholds: { ...base.thresholds, ...over.thresholds },
    ignore: over.ignore ?? base.ignore,
    maxRefactorAttempts: over.maxRefactorAttempts ?? base.maxRefactorAttempts,
    preCommit: { ...base.preCommit, ...over.preCommit },
    tsxOverrides: { ...base.tsxOverrides, ...over.tsxOverrides },
  };
}

/**
 * Loads the Cerberus config from cwd, layering: defaults <- preset (extends) <- user file.
 * Prefers `.cerberus.json`, falling back to the legacy `.quality-gate.json`.
 * Returns plain defaults when no config file is present.
 */
export function loadConfig(cwd: string): Config {
  const base = defaultConfig();

  const cerberusPath = join(cwd, CONFIG_FILE);
  const legacyPath = join(cwd, LEGACY_CONFIG_FILE);
  const path = existsSync(cerberusPath)
    ? cerberusPath
    : existsSync(legacyPath)
      ? legacyPath
      : null;
  if (!path) return base;

  let user: PartialConfig;
  try {
    user = JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
  } catch (err) {
    throw new Error(`Invalid ${path}: ${(err as Error).message}`);
  }

  let merged = base;
  if (user.extends) {
    const preset = PRESETS[user.extends];
    if (!preset) {
      throw new Error(`Unknown preset "${user.extends}" in ${path}`);
    }
    merged = merge(merged, preset);
  }
  return merge(merged, user);
}
