# ADR-0001 — `be-safe`: orquestrar `no-mistakes`, não fundir com o code-quality-gate

**Status:** Accepted — **orquestração via `commands.lint`, sem fork-e-merge**. Spike de arquitetura concluído (2026-06-21); ponto de extensão confirmado na doc do `no-mistakes` (pipeline fixo, comandos por step configuráveis).
**Date:** 2026-06-21
**Deciders:** Alison Galindo (Cowork)
**Related:** TheOrc ADR-0043 (model fusion — precedente de "extract, not fork"), ADR-0040/0041 (setup overhaul do TheOrc), ADR-0042 (anthropic credit breaker).
**External references:**
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT, Go, v1.6.0 / abr-2026) — git proxy local + pipeline de validação IA-driven + auto-fix + PR limpo.
- Doc: [The Gate Model](https://kunchenguid.github.io/no-mistakes/concepts/gate-model/), [Pipeline](https://kunchenguid.github.io/no-mistakes/concepts/pipeline/), [Auto-Fix Loop](https://kunchenguid.github.io/no-mistakes/concepts/auto-fix/), [Pipeline Steps](https://kunchenguid.github.io/no-mistakes/reference/pipeline-steps/).

---

## Context

O `code-quality-gate` resolve **"o quê verificar"**: 18 analyzers determinísticos
(cognitive/cyclomatic complexity, type-safety, N+1, migration-safety, secret-in-diff,
slopsquatting, silent-catch, hallucinated-import…), com delta-vs-baseline e um tier de
segurança não-bypassável. É específico ao nosso stack (Drizzle, Next.js, `'use server'`)
e maduro. Os triggers atuais são: hook `PostToolUse` do Claude Code, `pre-commit`, hook
`PreToolUse(Bash)`, e `check --base <ref>` em CI.

O `no-mistakes` resolve **"quando e onde rodar validação"**: é um git proxy em Go. Você dá
`git push no-mistakes` em vez de `origin`; ele cria um worktree descartável, roda um
pipeline fixo (`intent → rebase → review → test → document → lint → push → pr → ci`),
faz forward upstream só quando tudo passa, abre PR limpo e fica vigiando o CI com
auto-fix. Tem TUI, daemon, e uma skill `/no-mistakes` (interface `axi`) para um agente
dirigir o gate de forma não-interativa.

Dois objetivos do operador motivam essa decisão:

1. **PRs limpos automaticamente** — fechar o gap do `--no-verify`: o pre-commit hook é
   advisory e bypassável; o `no-mistakes` roda num worktree isolado **antes** do código
   sair da máquina, o que o pre-commit não garante.
2. **Auto-fix com agente de IA** — corrigir violações automaticamente antes do PR.

## A pegadinha que define a arquitetura

O `no-mistakes` valida com um **agente de IA** (review/test/lint são IA-driven). Usar IA
para checar o trabalho da IA é exatamente o ponto fraco que o `code-quality-gate` existe
para cobrir: detecção **determinística, sem alucinação**. E auto-fix só é confiável se o
validador for determinístico — senão o agente "conserta" engolindo o erro, que é
literalmente o anti-pattern `silent-catch` ("o #1 jeito de um LLM 'consertar' um teste que
falha").

O loop saudável é: **gate detecta (determinístico) → agente conserta → gate re-valida →
só passa se zerou de verdade → `no-mistakes` abre o PR**. Nenhum dos dois entrega isso
sozinho. Juntos, fecham o loop.

## Spike — o ponto de extensão existe e é exatamente onde precisamos (2026-06-21)

Pergunta do spike: *o pipeline de auto-fix do `no-mistakes` aceita plugar um validador
externo (nosso gate) no meio do loop?* **Sim.** A doc confirma:

- O pipeline tem **ordem fixa e não-configurável**, mas **o comando de cada step é
  configurável**: `commands.test`, `commands.lint`, `commands.format`.
- Quando `commands.lint` está **setado**, o step roda via shell (`sh -c`), e
  **exit não-zero produz findings**; esses findings entram no **loop de auto-fix**
  (`auto_fix.lint`, default 3): agente conserta → step **re-roda** → só passa se limpar.
- Quando `commands.lint` está **vazio**, o `no-mistakes` deixa o **próprio agente**
  detectar linters e aplicar fixes — ou seja, IA validando IA. **Não é o que queremos.**

Conclusão: configurando `commands.lint = "npx quality-gate check --base <ref> ..."` (ou
equivalente staged), o **nosso gate determinístico vira o validador do step `lint`**, e o
**loop de auto-fix do `no-mistakes` chama o agente para corrigir contra os nossos
findings e re-valida pelo gate** — exatamente o loop saudável descrito acima. O tier de
segurança não-bypassável do gate continua valendo (exit não-zero = step não passa).

Isso torna o **fork-e-merge desnecessário**: o `no-mistakes` já é agent-agnostic e
check-agnostic por design; ele foi feito para chamar comandos externos. O encaixe é nativo.

## Decision

Adotar **`be-safe` como suíte guarda-chuva**, composta por duas camadas com nomes próprios
e responsabilidades distintas — **sem fundir os codebases**:

- **`code-quality-gate`** (TS) = o **engine determinístico**. Continua sendo o "o quê".
  Permanece repo próprio, evolui independente.
- **`no-mistakes`** (Go, upstream) = o **orquestrador** (worktree, push-gate, auto-fix,
  PR, CI-watch). Consumido como ferramenta, **não forkado para merge**.

Integração: `no-mistakes` chama o `code-quality-gate` via `commands.lint` (e/ou
`commands.test`), de modo que:

1. o gate roda **localmente, em worktree isolado, antes do upstream** (fecha o gap do
   `--no-verify`);
2. findings do gate alimentam o **loop de auto-fix** do `no-mistakes`;
3. o agente corrige e o **gate re-valida** antes de abrir o PR;
4. o PR só sai **limpo** — atendendo aos dois objetivos (PR limpo + auto-fix).

Esse loop é também a "luva de segurança" natural para a execução autônoma do **The Orc**
(push limpo + auto-fix + PR), via a skill `/no-mistakes` (`axi`).

### Precedente

Mesma postura do **ADR-0043** do TheOrc sobre o Trae Agent: *"we are not forking it; we
extract its design."* Aqui nem extraímos código — **consumimos** o binário e plugamos
nosso gate no ponto de extensão oficial.

## Consequences

**Positivas**
- Sem merge Go↔TS: zero acoplamento de codebase, zero merge-hell em `git pull` upstream.
- Herdamos melhorias do `no-mistakes` de graça (projeto ativo, releases frequentes).
- Determinismo preservado: o validador do auto-fix é o nosso gate, não um agente.
- Enforcement local pré-PR (gap do `--no-verify` fechado) sem reescrever nada.
- Caminho direto para o The Orc via skill `/no-mistakes`.

**Negativas / riscos**
- Dependência operacional de um binário de terceiro (mitigação: pin de versão; é MIT,
  podemos vendorizar/forkar se o upstream morrer).
- O `commands.lint` espera um comando shell com semântica exit-code + findings em texto;
  precisamos validar que o `--format` do gate rende bem como findings no TUI/PR do
  `no-mistakes` (ver Open question).
- O step `review` do `no-mistakes` continua IA-driven (auto_fix default 0 = pede
  aprovação). Isso é aceitável: review é julgamento, não é o eixo determinístico.

**Quando reconsiderar o fork**
- Só se precisarmos plugar o gate **entre detect e fix dentro de um step que hoje não
  expõe `commands.*`** (ex.: rodar o gate como gate do step `review`), ou inserir um step
  determinístico novo (o pipeline não permite adicionar steps). Aí forkaríamos para abrir
  esse ponto de extensão — não para fundir.

## Naming

- Suíte: **`be-safe`** (comunica intenção, fácil de falar) — mantida.
- Camadas internas seguem com nome próprio: `code-quality-gate` (engine), `no-mistakes`
  (trilho).
- Alternativas temáticas descartadas por ora (registro): **Cerberus** (guardião de 3
  cabeças: detect/fix/ship), **Aegis** (escudo, casa com a mitologia do Hermes),
  **Bouncer**.

## Open questions / próximos passos

1. **POC de 1 dia:** `no-mistakes init` num repo de produto (oxe.bio ou Bravus), setar
   `commands.lint` apontando pro `quality-gate check`, dar um `git push no-mistakes` numa
   branch com violação plantada, e confirmar: (a) o step `lint` falha com os findings do
   gate; (b) o auto-fix dispara; (c) o gate re-valida; (d) o PR sai limpo.
2. Validar o formato de saída do gate consumido pelo `no-mistakes` (texto/exit-code) e se
   vale um `--format no-mistakes` dedicado.
3. Decidir `commands.test` vs `commands.lint` (ou ambos) como ponto de entrada do gate.
4. Versão pinada do `no-mistakes` + política de update no ecossistema atipicos.
