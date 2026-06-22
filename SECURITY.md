# Security Policy

Cerberus is a security tool, so we take its own security seriously.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub:
on the repository's **Security** tab, choose **Report a vulnerability** (GitHub private vulnerability reporting).
This opens a private advisory visible only to the maintainers.

When you report, include:

- a description of the issue and its impact,
- the version / commit (or git tag) you reproduced it on,
- a minimal reproduction (a diff, a config, or the exact command), and
- any suggested fix, if you have one.

We aim to acknowledge a report within a few days and to ship a fix or a mitigation as fast as the severity warrants.
Once a fix is released we'll credit you in the advisory unless you prefer to stay anonymous.

## Scope

What's in scope:

- **Bypasses of the security tier.** Any way to land a leaked secret, an injection sink, an unsafe migration, or a slopsquatted dependency past `cerberus check` (the CLI, the git hook, the Claude Code hooks, or `check --base` in CI).
- **Code execution or unexpected writes** by the gate itself when it analyzes attacker-influenced input (a crafted diff, config, baseline, or filename).
- **False negatives in a security analyzer** that a real attacker could rely on.

What's expected behavior, not a vulnerability:

- Local hooks are **advisory** by design and can be skipped with `git commit --no-verify`. The CI gate (`check --base`) is the hard enforcement point — see [docs/ci-and-languages.md](./docs/ci-and-languages.md). A report that only relies on `--no-verify` without also defeating CI is out of scope.
- Quality (non-security) violations can be bypassed (`CERBERUS_BYPASS=1`, `[skip-cerberus]`, the anti-doom-loop). That is intended; only the security tier is non-bypassable.

## Supported versions

Fixes are released against the latest tag. Pin a tag (`github:alissonrgalindo/cerberus#vX.Y.Z`) and upgrade to pick them up.
