# Runbook — finalizar o rename para Cerberus e migrar os projetos

> **Para o agente executor (Claude Code):** este runbook é auto-suficiente. Execute as fases
> **em ordem**. Cada fase tem um passo de **verificação** — só avance se ele passar. Pare e
> reporte se qualquer verificação falhar. Não faça `find-and-replace` cego em comentários de
> suppress (alguns são de segurança). Trabalhe sempre com caminhos absolutos.

## Contexto (o que já foi feito vs. o que falta)

O repositório `code-quality-gate` foi renomeado para **Cerberus** no código-fonte, **com
retrocompatibilidade total** (os nomes antigos seguem funcionando como alias). O que **já está
feito** dentro de `code-quality-gate/`:

- `package.json`: `name: "cerberus"`, `version: "0.2.0"`, bin `cerberus` + `quality-gate` (alias).
- `.claude-plugin/plugin.json`: `name: "cerberus"`.
- `src/config.ts`: lê `.cerberus.json` (fallback `.quality-gate.json`); presets `@cerberus/*` + `@quality-gate/*`.
- `src/baseline.ts`: `.cerberus-baseline.json` (fallback `.quality-gate-baseline.json`).
- `src/cli.ts`: `CERBERUS_BYPASS` / `[skip-cerberus]` (+ aliases legados).
- `src/injector.ts`: TODO flag `// TODO: cerberus(...)`.
- `src/reporter.ts`: output `✓/✗ cerberus:`.
- `src/analyzers/{injection,shallow-module,secret-in-diff,python}.ts`: suppress casa `(?:cerberus|quality-gate)-allow`.
- README + `PUBLISH-CERBERUS.md` atualizados.

O que **falta** (este runbook): commitar/publicar o repo privado, fazer os consumidores
(Bravus, oxe, TheOrc) usarem o pacote publicado em vez do **path absoluto hardcoded**, e
migrar os hooks. Há também um passo opcional de limpeza dos nomes legados.

**Paths canônicos** (ajuste se sua árvore difere):
- Cerberus (engine): `/Volumes/SSD/GitHub/atipicos/code-quality-gate`
- Bravus: `/Volumes/SSD/GitHub/atipicos/gymapp`
- oxe: `/Volumes/SSD/GitHub/atipicos/personal-linktree`
- TheOrc: `/Volumes/SSD/GitHub/atipicos/TheOrc`
- **Cópia antiga a remover no fim:** `/Volumes/SSD/GitHub/code-quality-gate` (fora do atipicos)

Substitua `<ORG>` pela org/conta GitHub onde o repo privado vai morar.

---

## Fase 0 — Pré-checagens

```bash
cd /Volumes/SSD/GitHub/atipicos/code-quality-gate
node --version            # >= 20
gh auth status            # precisa estar autenticado
git status                # ver mudanças do rename ainda não commitadas
```

**Verificação:** `gh auth status` diz "Logged in". Se não, rode `gh auth login` e pare aqui
até resolver.

---

## Fase 1 — Build + testes do Cerberus

```bash
cd /Volumes/SSD/GitHub/atipicos/code-quality-gate
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

**Verificação:** build gera `dist/cli.js`; `pnpm test` passa (a suíte cobre config/baseline/
analyzers — inclusive os aliases legados); typecheck sem erros. Se algum teste falhar,
**pare e reporte o nome do teste** — não prossiga com rename quebrado.

### Smoke test funcional dos aliases (rápido, num tmp)
```bash
T=$(mktemp -d); cd "$T"; git init -q; git config user.email a@a.co; git config user.name a
CLI=/Volumes/SSD/GitHub/atipicos/code-quality-gate/dist/cli.js

# config novo + suppress LEGADO deve silenciar o secret:
echo '{ "extends": "@cerberus/nextjs" }' > .cerberus.json
printf 'const k="sk-ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"; // quality-gate-allow: secret\nexport const x=k;\n' > s.ts
node "$CLI" check --file s.ts        # espera: "✓ cerberus: all checks passed"

# secret SEM suppress deve ser pego:
printf 'export const k="sk-ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";\n' > leak.ts
node "$CLI" check --file leak.ts     # espera: linha "SECURITY  secret-in-diff" e exit != 0
cd - >/dev/null
```

**Verificação:** primeiro comando passa limpo (suppress legado respeitado); segundo acusa o
secret. Se o suppress legado NÃO silenciar, a retrocompat quebrou — pare e reporte.

---

## Fase 2 — Commit + publicar repo privado

```bash
cd /Volumes/SSD/GitHub/atipicos/code-quality-gate
git add -A
git commit -m "rename: code-quality-gate -> Cerberus (v0.2.0, retrocompat total)"

# cria o repo privado e adiciona como remote 'origin' se ainda não existir:
git remote get-url origin 2>/dev/null \
  && git push -u origin HEAD \
  || gh repo create <ORG>/cerberus --private --source=. --remote=origin --push

# tag de versão fixável pelos consumidores:
git tag v0.2.0
git push origin v0.2.0
```

**Verificação:** `gh repo view <ORG>/cerberus` mostra o repo **Private**; `git ls-remote --tags origin`
lista `v0.2.0`.

> Opcional: renomear a pasta local para casar com o repo:
> `cd .. && mv code-quality-gate cerberus`. **Se fizer isso**, atualize os fallbacks de path
> nas Fases 3–5 de `.../code-quality-gate/dist/cli.js` para `.../cerberus/dist/cli.js`.

---

## Fase 3 — Migrar o Bravus (gymapp)

Bravus consome o gate em **dois** lugares com path hardcoded: `.husky/pre-commit` e
`.claude/settings.json`. Vamos trocar pelo pacote publicado.

```bash
cd /Volumes/SSD/GitHub/atipicos/gymapp
pnpm add -D "cerberus@git+ssh://git@github.com:<ORG>/cerberus.git#v0.2.0"
pnpm exec cerberus --help     # confirma binário resolvível via node_modules/.bin
```

### 3a. `.husky/pre-commit`
Substitua a linha que invoca o gate (a que tem `node "/Volumes/SSD/GitHub/code-quality-gate/dist/cli.js"`)
de modo que o arquivo fique:

```sh
#!/bin/sh
set -e
pnpm --filter @bravus/pro exec lint-staged
# cerberus-hook
[ "$CERBERUS_BYPASS" = "1" ] || [ "$QUALITY_GATE_BYPASS" = "1" ] || \
  pnpm exec cerberus check --staged --mode pre-commit --format human || exit 1
```
Mantenha o arquivo executável: `chmod +x .husky/pre-commit`.

### 3b. `.claude/settings.json`
No hook `PreToolUse > Bash`, troque o comando:
```
node "/Volumes/SSD/GitHub/code-quality-gate/dist/cli.js" claude-hook
```
por:
```
pnpm exec cerberus claude-hook
```
(Edite só o valor `"command"`; preserve o resto do JSON. Valide com `python3 -m json.tool .claude/settings.json`.)

**Verificação (Bravus):**
```bash
cd /Volumes/SSD/GitHub/atipicos/gymapp
grep -R "GitHub/code-quality-gate" .husky .claude   # NÃO deve retornar nada
python3 -m json.tool .claude/settings.json >/dev/null && echo "settings.json válido"
# dry-run do pre-commit sem commitar:
git add -A && pnpm exec cerberus check --staged --format human || true
```
Deve rodar o Cerberus sem path absoluto. O `.quality-gate.json` existente continua válido
(alias) — **não precisa renomear agora** (ver Fase 6).

---

## Fase 4 — Migrar o oxe (personal-linktree) + criar husky do zero

oxe usa o gate via `.claude/settings.json` e **não tem** husky. Vamos: instalar o Cerberus,
migrar o claude-hook, e **criar `.husky/pre-commit` do zero** (husky completo).

> **Nota:** oxe **não tem** `lint-staged` configurado, então o hook roda **só o cerberus**
> (não copie a linha `lint-staged` do Bravus — quebraria).

### 4a. Instalar Cerberus + husky
```bash
cd /Volumes/SSD/GitHub/atipicos/personal-linktree
pnpm add -D "cerberus@git+ssh://git@github.com:<ORG>/cerberus.git#v0.2.0"
pnpm add -D husky
pnpm pkg set scripts.prepare="husky"   # adiciona "prepare": "husky" no package.json
pnpm run prepare                        # inicializa o diretório .husky/
```

### 4b. Criar `.husky/pre-commit`
```bash
cat > .husky/pre-commit <<'EOF'
#!/bin/sh
set -e
# cerberus-hook
[ "$CERBERUS_BYPASS" = "1" ] || [ "$QUALITY_GATE_BYPASS" = "1" ] || \
  pnpm exec cerberus check --staged --mode pre-commit --format human || exit 1
EOF
chmod +x .husky/pre-commit
```

### 4c. `.claude/settings.json`
Troque o comando do claude-hook:
```
node "/Volumes/SSD/GitHub/code-quality-gate/dist/cli.js" claude-hook
```
por:
```
pnpm exec cerberus claude-hook
```
(Edite só o valor `"command"`; valide com `python3 -m json.tool .claude/settings.json`.)

**Verificação (oxe):**
```bash
cd /Volumes/SSD/GitHub/atipicos/personal-linktree
grep -R "GitHub/code-quality-gate" .claude .husky   # NÃO deve retornar nada
python3 -m json.tool .claude/settings.json >/dev/null && echo "settings.json ok"
test -x .husky/pre-commit && echo "hook executável ok"
pnpm exec cerberus --help >/dev/null && echo "binário ok"
# dry-run:
git add -A && pnpm exec cerberus check --staged --format human || true
```

---

## Fase 5 — Migrar o TheOrc (remover vendor + criar husky)

TheOrc tem o gate **vendorizado** em `tools/quality-gate/` (cópia própria, v0.0.2 — código
defasado). Vamos **substituí-lo pela dependência Cerberus** e criar `.husky/pre-commit`.
**Atenção:** TheOrc usa `pnpm@9.12.0`. TheOrc também **não tem** `lint-staged` → hook roda
só o cerberus.

### 5a. Instalar Cerberus + husky, remover o vendor
```bash
cd /Volumes/SSD/GitHub/atipicos/TheOrc
pnpm add -D "cerberus@git+ssh://git@github.com:<ORG>/cerberus.git#v0.2.0"
pnpm add -D husky
pnpm pkg set scripts.prepare="husky"
pnpm run prepare

# Antes de remover o vendor, mapeie quem o referencia:
grep -RIn "tools/quality-gate\|tools\\\\quality-gate" . \
  --include="*.json" --include="*.sh" --include="*.mjs" --include="*.ts" \
  --include="*.yml" --include="*.yaml" | grep -v node_modules
```
Para cada referência encontrada (scripts em package.json, .githooks antigo, docs de setup),
troque a invocação do vendor (`node tools/quality-gate/cli.js ...`) por `pnpm exec cerberus ...`.
Depois remova o vendor:
```bash
git rm -r tools/quality-gate
```

### 5b. Criar `.husky/pre-commit`
```bash
cat > .husky/pre-commit <<'EOF'
#!/bin/sh
set -e
# cerberus-hook
[ "$CERBERUS_BYPASS" = "1" ] || [ "$QUALITY_GATE_BYPASS" = "1" ] || \
  pnpm exec cerberus check --staged --mode pre-commit --format human || exit 1
EOF
chmod +x .husky/pre-commit
```
> Se o TheOrc tinha `git config core.hooksPath .githooks` (do esquema antigo), reverta para
> o padrão do husky: `git config --unset core.hooksPath` (husky usa `.husky/_`).

**Verificação (TheOrc):**
```bash
cd /Volumes/SSD/GitHub/atipicos/TheOrc
test ! -d tools/quality-gate && echo "vendor removido ok"
grep -RIn "tools/quality-gate\|GitHub/code-quality-gate" . \
  --include="*.json" --include="*.sh" --include="*.mjs" --include="*.ts" \
  | grep -v node_modules    # NÃO deve retornar nada
test -x .husky/pre-commit && echo "hook executável ok"
pnpm exec cerberus --help >/dev/null && echo "binário ok"
git add -A && pnpm exec cerberus check --staged --format human || true
```

---

## Fase 6 — Remover a cópia antiga + (opcional) limpar nomes legados

### 6a. Remover o diretório antigo (só depois das Fases 3–5 verificadas)
```bash
# confirme que NINGUÉM mais aponta pra cópia antiga:
grep -RIn "GitHub/code-quality-gate" /Volumes/SSD/GitHub/atipicos \
  --include="*.json" --include="*.sh" --include="*.yaml" --include="*.yml" \
  | grep -v node_modules
# se vazio, pode remover:
rm -rf /Volumes/SSD/GitHub/code-quality-gate
```

### 6b. (Opcional, sem pressa) renomear nomes legados por repo
Não é necessário — os aliases funcionam. Quando quiser limpar, **por repo**:
```bash
# config + baseline:
git mv .quality-gate.json .cerberus.json 2>/dev/null || true
git mv .quality-gate-baseline.json .cerberus-baseline.json 2>/dev/null || true
# preset dentro do .cerberus.json: trocar "@quality-gate/" por "@cerberus/"
```
Os comentários `// quality-gate-allow:` (≈24 no Bravus, 1 no oxe) podem virar
`// cerberus-allow:` **gradualmente, um a um, revisando** — vários são suppress de
segurança (secret/injection). **NÃO** faça `sed` global nesses.

---

## Fase 7 — Commit final dos consumidores

Em cada repo migrado (Bravus, oxe, TheOrc), commit nas respectivas convenções:
```bash
git add -A
git commit -m "chore: consume Cerberus as git devDependency (drop hardcoded path)"
```
Não dê push se o repo exigir PR — siga a convenção de cada projeto (ver o CLAUDE.md de cada).

---

## Checklist final

- [ ] Cerberus buildou, testou e publicou privado com tag `v0.2.0`.
- [ ] Smoke test: suppress legado silencia, secret sem suppress é pego.
- [ ] Bravus: `.husky/pre-commit` e `.claude/settings.json` sem path absoluto; cerberus via `pnpm exec`.
- [ ] oxe: Cerberus + husky instalados; `.husky/pre-commit` criado; `.claude/settings.json` migrado.
- [ ] TheOrc: vendor `tools/quality-gate` removido; Cerberus + husky instalados; `.husky/pre-commit` criado; refs ao vendor migradas.
- [ ] Os três têm `"prepare": "husky"` no package.json (oxe/TheOrc são novos).
- [ ] `grep -RIn "GitHub/code-quality-gate\|tools/quality-gate" ... | grep -v node_modules` vazio em todo o atipicos.
- [ ] Cópia antiga `/Volumes/SSD/GitHub/code-quality-gate` removida.
- [ ] Commits feitos em cada repo.

## Notas de segurança (não pule)

- O tier de segurança do Cerberus (`secret-in-diff`, `injection`, `migration-safety`,
  `new-dependency`) é **não-bypassável** — `CERBERUS_BYPASS`/`[skip-cerberus]` só pulam os
  analyzers de qualidade. Não tente contornar.
- Ao migrar suppress comments, um suppress de segurança que pare de funcionar **re-expõe** o
  que estava conscientemente permitido. Por isso a Fase 6b é manual e revisada.
- Se um teste de retrocompat falhar em qualquer fase, **pare** — não publique nem migre um
  gate que mudou de comportamento.
