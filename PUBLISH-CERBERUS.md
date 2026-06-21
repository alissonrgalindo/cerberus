# Publicar o Cerberus (privado) + migrar consumidores

Renomeamos `code-quality-gate` → **Cerberus**. O rename foi feito **com retrocompatibilidade
total**: o parser aceita os nomes antigos (`.quality-gate.json`, `@quality-gate/*`,
`// quality-gate-allow`, `QUALITY_GATE_BYPASS`) como aliases. Então **nada nos repos de
produto quebra** — a migração abaixo é pra resolver o path hardcoded e distribuir pra equipe,
não é urgente.

Verificado nesta sessão (CLI compilado): `.cerberus.json` + preset `@cerberus/nextjs`
funcionam; suppress legado `// quality-gate-allow: secret` ainda silencia; suppress novo
`// cerberus-allow: secret` silencia; secret sem suppress é pego (segurança intacta).

## O que mudou na marca

| Antes | Agora (canônico) | Legado ainda aceito? |
|---|---|---|
| repo `code-quality-gate` | repo `cerberus` | — |
| binário `quality-gate` | `cerberus` | ✅ `quality-gate` mantido como bin alias |
| `.quality-gate.json` | `.cerberus.json` | ✅ lido se `.cerberus.json` ausente |
| `.quality-gate-baseline.json` | `.cerberus-baseline.json` | ✅ lido como fallback |
| presets `@quality-gate/*` | `@cerberus/*` | ✅ alias |
| `// quality-gate-allow:` | `// cerberus-allow:` | ✅ ambos casam |
| `QUALITY_GATE_BYPASS=1` | `CERBERUS_BYPASS=1` | ✅ ambos |
| `[skip-quality]` | `[skip-cerberus]` | ✅ ambos |
| TODO flag `quality-gate(...)` | `cerberus(...)` | (novo only) |
| output `✓ quality-gate:` | `✓ cerberus:` | (cosmético) |

## 1. Publicar como repo privado no GitHub

```bash
cd /Volumes/SSD/GitHub/atipicos/code-quality-gate
# (opcional) renomear a pasta local para casar com o repo:
#   cd .. && mv code-quality-gate cerberus && cd cerberus

gh repo create <org-ou-voce>/cerberus --private --source=. --remote=origin
git add -A
git commit -m "rename: code-quality-gate -> Cerberus (retrocompat total)"
git push -u origin main
```

> README já marca "private / internal tool". Mantido privado por estar em fase de teste.

## 2. Consumir como devDependency (resolve o path hardcoded)

Em cada repo de produto (Bravus `gymapp`, oxe `personal-linktree`, TheOrc):

```bash
pnpm add -D "cerberus@git+ssh://git@github.com:<org>/cerberus.git#main"
# fixar versão é melhor que #main em fase de teste — use uma tag:
#   git tag v0.2.0 && git push --tags     (no repo cerberus)
#   pnpm add -D "cerberus@git+ssh://git@github.com:<org>/cerberus.git#v0.2.0"
```

Isso instala o binário em `node_modules/.bin/cerberus` — **fim do caminho absoluto da sua
máquina**. Qualquer membro da equipe que rodar `pnpm install` passa a ter o Cerberus.

> O pacote invoca `jscpd` como subprocess e resolve `ts-morph` do disco, então precisa do
> `node_modules` do próprio pacote disponível (o git-dep do pnpm cuida disso ao instalar).

## 3. Migrar os hooks dos repos de produto (são protegidos — aplicar você mesmo)

Esses arquivos não pude editar na sessão (hooks executáveis / settings). Aplique:

### `gymapp/.husky/pre-commit`
Troque a linha do quality-gate por (prefere o binário instalado, sem path absoluto):

```sh
#!/bin/sh
set -e
pnpm --filter @bravus/pro exec lint-staged
# cerberus-hook
[ "$CERBERUS_BYPASS" = "1" ] || [ "$QUALITY_GATE_BYPASS" = "1" ] || \
  pnpm exec cerberus check --staged --mode pre-commit --format human || exit 1
```

### `gymapp/.claude/settings.json`
No hook `PreToolUse > Bash`, troque:

```json
"command": "node \"/Volumes/SSD/GitHub/code-quality-gate/dist/cli.js\" claude-hook"
```
por:
```json
"command": "pnpm exec cerberus claude-hook"
```

> Aplique o equivalente em `personal-linktree` e `TheOrc` (mesmos dois pontos).
> Depois disso, pode **apagar a cópia antiga** em `/Volumes/SSD/GitHub/code-quality-gate`.

## 4. (Opcional, sem pressa) migrar nomes legados

Não é necessário — os aliases funcionam. Quando quiser limpar, por repo:

- renomear `.quality-gate.json` → `.cerberus.json` e `.quality-gate-baseline.json` →
  `.cerberus-baseline.json`;
- trocar `extends: "@quality-gate/..."` → `"@cerberus/..."`;
- os ~24 comentários `// quality-gate-allow:` no Bravus podem virar `// cerberus-allow:`
  gradualmente — **um de cada vez, revisando**, já que alguns são suppress de segurança
  (secret/injection). Não faça find-and-replace cego nesses.

## 5. Cerberus completo (com no-mistakes)

Lembre que o engine (este repo) é metade do Cerberus. A outra metade é o orquestrador
`no-mistakes` — ver `gymapp/CERBERUS-SETUP.md` e os ADRs `decisions/0001` e `0002`.
