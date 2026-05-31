import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from './defaults.js';
import monorepoPreset from './presets/monorepo-turborepo.json';
import nextjsPreset from './presets/nextjs.json';
import nodeCliPreset from './presets/node-cli.json';
import type { Config } from './types.js';

type PartialConfig = Partial<Config> & { extends?: string };

/** Internal presets resolvable via `extends`. */
const PRESETS: Record<string, PartialConfig> = {
  '@quality-gate/nextjs': nextjsPreset as PartialConfig,
  nextjs: nextjsPreset as PartialConfig,
  '@quality-gate/node-cli': nodeCliPreset as PartialConfig,
  'node-cli': nodeCliPreset as PartialConfig,
  '@quality-gate/monorepo-turborepo': monorepoPreset as PartialConfig,
  'monorepo-turborepo': monorepoPreset as PartialConfig,
};

export const CONFIG_FILE = '.quality-gate.json';

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
 * Loads `.quality-gate.json` from cwd, layering: defaults <- preset (extends) <- user file.
 * Returns plain defaults when no config file is present.
 */
export function loadConfig(cwd: string): Config {
  const base = defaultConfig();
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return base;

  let user: PartialConfig;
  try {
    user = JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_FILE}: ${(err as Error).message}`);
  }

  let merged = base;
  if (user.extends) {
    const preset = PRESETS[user.extends];
    if (!preset) {
      throw new Error(`Unknown preset "${user.extends}" in ${CONFIG_FILE}`);
    }
    merged = merge(merged, preset);
  }
  return merge(merged, user);
}
