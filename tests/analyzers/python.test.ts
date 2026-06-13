import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzePyHallucinatedImport,
  analyzePyInjection,
  analyzePySilentCatch,
  extractDeclaredPyDeps,
  findPyInjections,
  findPySilentCatches,
  normalizePyName,
} from '../../src/analyzers/python.js';
import { inputFromSource } from '../helpers.js';

describe('py silent-catch', () => {
  it('passes clean code', async () => {
    const r = await analyzePySilentCatch(inputFromSource('app.py', 'def f(x):\n    return x + 1\n'));
    expect(r.passed).toBe(true);
  });

  it('flags except: pass', () => {
    const src = `try:
    risky()
except Exception:
    pass
`;
    const out = findPySilentCatches(src);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
  });

  it('flags single-line except: pass', () => {
    const out = findPySilentCatches('try:\n    risky()\nexcept ValueError: pass\n');
    expect(out).toHaveLength(1);
  });

  it('flags except bodies that only print/log', () => {
    const src = `try:
    risky()
except Exception as e:
    print(e)
    logging.error(e)
`;
    expect(findPySilentCatches(src)).toHaveLength(1);
  });

  it('passes when the except re-raises', () => {
    const src = `try:
    risky()
except Exception as e:
    logging.error(e)
    raise
`;
    expect(findPySilentCatches(src)).toHaveLength(0);
  });

  it('passes when the except has real handling', () => {
    const src = `try:
    risky()
except KeyError:
    value = default()
`;
    expect(findPySilentCatches(src)).toHaveLength(0);
  });

  it('respects the suppression comment', () => {
    const src = `try:
    risky()
except Exception:  # quality-gate-allow: silent-catch
    pass
`;
    expect(findPySilentCatches(src)).toHaveLength(0);
  });
});

describe('py injection', () => {
  it('flags eval with dynamic input', () => {
    const out = findPyInjections('result = eval(user_input)\n');
    expect(out).toHaveLength(1);
    expect(out[0].detail).toMatch(/eval/);
  });

  it('passes eval with a literal', () => {
    expect(findPyInjections('x = eval("1 + 1")\n')).toHaveLength(0);
  });

  it('flags os.system with an f-string', () => {
    const out = findPyInjections('os.system(f"rm -rf {path}")\n');
    expect(out).toHaveLength(1);
  });

  it('flags os.system with concatenation', () => {
    expect(findPyInjections('os.system("ls " + directory)\n')).toHaveLength(1);
  });

  it('passes os.system with a literal', () => {
    expect(findPyInjections('os.system("ls -la")\n')).toHaveLength(0);
  });

  it('flags subprocess.run with shell=True and dynamic command', () => {
    const out = findPyInjections('subprocess.run(f"tool {arg}", shell=True)\n');
    expect(out).toHaveLength(1);
  });

  it('passes subprocess.run with a list of args', () => {
    expect(findPyInjections('subprocess.run(["tool", arg])\n')).toHaveLength(0);
  });

  it('flags cursor.execute with an f-string', () => {
    const out = findPyInjections(`cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")\n`);
    expect(out).toHaveLength(1);
    expect(out[0].fix).toMatch(/parameterized/);
  });

  it('flags cursor.execute with %-formatting on the string', () => {
    expect(findPyInjections(`cursor.execute("SELECT * FROM users WHERE id = %s" % user_id)\n`)).toHaveLength(1);
  });

  it('passes parameterized cursor.execute', () => {
    expect(
      findPyInjections(`cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))\n`),
    ).toHaveLength(0);
  });

  it('respects the suppression comment', () => {
    expect(findPyInjections('os.system(f"x {y}")  # quality-gate-allow: injection\n')).toHaveLength(0);
  });

  it('marks violations as security severity', async () => {
    const r = await analyzePyInjection(inputFromSource('app.py', 'eval(data)\n'));
    expect(r.violations[0].severity).toBe('security');
  });
});

describe('py hallucinated-import', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qg-py-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function pyInput(source: string): ReturnType<typeof inputFromSource> {
    const file = join(dir, 'app.py');
    writeFileSync(file, source);
    return inputFromSource(file, source);
  }

  it('no-ops when no manifest exists', async () => {
    const r = await analyzePyHallucinatedImport(pyInput('import totallymadeup\n'));
    expect(r.passed).toBe(true);
  });

  it('passes stdlib and declared imports', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), `[project]\ndependencies = ["requests>=2.0"]\n`);
    const r = await analyzePyHallucinatedImport(
      pyInput('import os\nimport json\nimport requests\nfrom requests import get\n'),
    );
    expect(r.passed).toBe(true);
  });

  it('flags an undeclared import', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), `[project]\ndependencies = ["requests>=2.0"]\n`);
    const r = await analyzePyHallucinatedImport(pyInput('import flask_easy_auth\n'));
    expect(r.passed).toBe(false);
    expect(r.violations[0].suggestion).toMatch(/flask_easy_auth/);
  });

  it('resolves import aliases (yaml → pyyaml)', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), `[project]\ndependencies = ["pyyaml"]\n`);
    const r = await analyzePyHallucinatedImport(pyInput('import yaml\n'));
    expect(r.passed).toBe(true);
  });

  it('skips local modules', async () => {
    writeFileSync(join(dir, 'pyproject.toml'), `[project]\ndependencies = []\n`);
    mkdirSync(join(dir, 'utils'));
    writeFileSync(join(dir, 'utils', '__init__.py'), '');
    writeFileSync(join(dir, 'helpers.py'), '');
    const r = await analyzePyHallucinatedImport(pyInput('import utils\nimport helpers\nfrom . import sibling\n'));
    expect(r.passed).toBe(true);
  });

  it('reads poetry-style dependencies', async () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      `[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n`,
    );
    const r = await analyzePyHallucinatedImport(pyInput('import httpx\n'));
    expect(r.passed).toBe(true);
  });

  it('reads requirements.txt', async () => {
    writeFileSync(join(dir, 'requirements.txt'), `requests>=2.0\n# comment\nnumpy==1.26.0\n`);
    const r = await analyzePyHallucinatedImport(pyInput('import numpy\nimport requests\n'));
    expect(r.passed).toBe(true);
  });
});

describe('py dep extraction helpers', () => {
  it('normalizes PEP 503 names', () => {
    expect(normalizePyName('Python_Dotenv')).toBe('python-dotenv');
    expect(normalizePyName('zope.interface')).toBe('zope-interface');
  });

  it('extracts from PEP 621 dependency arrays', () => {
    const toml = `[project]
dependencies = [
  "fastapi>=0.100",
  "uvicorn[standard]>=0.23",
]
`;
    const deps = extractDeclaredPyDeps('pyproject.toml', toml);
    expect(deps.has('fastapi')).toBe(true);
    expect(deps.has('uvicorn')).toBe(true);
  });
});
