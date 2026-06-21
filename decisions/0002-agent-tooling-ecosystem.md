# ADR-0002 — Agent tooling ecosystem: treehouse, axi, lavish-axi, ponytail

**Status:** Accepted (avaliação). Adoção faseada — ponytail + Cerberus no Bravus agora; treehouse reservado pro TheOrc; axi/lavish-axi como referência/opt-in.
**Date:** 2026-06-21
**Deciders:** Alison Galindo (Cowork)
**Related:** ADR-0001 (Cerberus = code-quality-gate + no-mistakes), TheOrc ADR-0042 (credit breaker — custo importa), ADR-0043 (extract-not-fork).
**External references:**
- [kunchenguid/treehouse](https://github.com/kunchenguid/treehouse) (MIT, Go) — pool de worktrees reutilizáveis.
- [kunchenguid/axi](https://github.com/kunchenguid/axi) (MIT) — 10 princípios de design agent-ergonomic + skill. [axi.md](https://axi.md).
- [kunchenguid/lavish-axi](https://github.com/kunchenguid/lavish-axi) (MIT) — editor de artefatos HTML p/ loop humano-agente.
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT, 44k★) — skill anti-over-engineering.

> As três `kunchenguid` são da mesma autora do `no-mistakes` (base do Cerberus) — mesma
> filosofia AXI/TOON, combinam por design. `ponytail` é de outro autor, complementar.

## Context

Avaliação de 4 ferramentas open-source para o ecossistema atipicos (oxe.bio, Bravus,
TheOrc, Hermes, Cerberus), perguntando por ferramenta: serve todos os projetos ou só o
TheOrc? A pressão de custo do ADR-0042 (credit breaker) torna "menos token / menos código"
um critério de primeira ordem, não cosmético.

## Decision — encaixe por ferramenta

### ponytail — **adotar, todos os projetos. Complemento do Cerberus.**
Skill/plugin que faz o agente subir uma escada antes de escrever código (precisa existir? →
stdlib? → feature nativa? → dep instalada? → uma linha? → mínimo que funciona), sem nunca
cortar validação de trust-boundary, segurança, ou acessibilidade. Benchmark agêntico real
(FastAPI+React, Haiku 4.5, n=4): **-54% LOC, -20% custo, -27% tempo, 100% safe**.

**Divisão de trabalho com o Cerberus:** ponytail é **preventivo** (no prompt, evita escrever
over-engineering); o `code-quality-gate` é **corretivo** (no gate: shallow-module,
function-length, complexity). Menos código gerado → menos violações no gate → menos
auto-fix loops do no-mistakes → menos custo. Risco baixíssimo (é ruleset/prompt, não toca
infra). Instala como plugin Claude Code (marketplace). **Adoção: agora, junto com o setup
do Cerberus no Bravus; depois nos demais.**

### treehouse — **adotar no TheOrc (execução paralela).**
CLI Go que mantém um **pool de worktrees quentes** por repo (deps + build cache intactos),
entregando um worktree limpo na hora sem reclonar. Mata exatamente a dor registrada no
CLAUDE.md do atipicos (artefatos pesados — `node_modules`/`.next`/`.turbo`/`.venv` — foram
stripados e precisam reinstalar a cada sessão fria). O TheOrc roda múltiplos agentes em
paralelo → é onde o ganho é máximo.

**Não confundir com o no-mistakes:** responsabilidades distintas — `no-mistakes` cria
worktree **descartável** por push/validação; `treehouse` mantém pool **quente** para
execução. Coexistem. **Adoção: momento dedicado no TheOrc, não no setup do Bravus agora**
(a menos que se rode swarm de agentes no Bravus também).

### axi — **referência de design, não dependência.**
Não é app: são 10 princípios (output TOON ~40% < JSON, schemas mínimos 3-4 campos, exit
codes estruturados, contextual disclosure) + skill de scaffolding. Benchmark: `gh-axi` 100%
sucesso a $0.05 vs GitHub MCP 87% a $0.148. É a "constituição" que o `no-mistakes` (interface
`axi`) e o `lavish-axi` já seguem.

**Encaixe:** padrão a adotar **ao expor CLIs internos a agentes** — concretamente, um
`--format toon`/`--format axi` no `code-quality-gate` e na superfície do TheOrc baixaria
custo de token quando um agente consome os findings. **Adoção: referência; vira trabalho
real só quando formos construir/expor um CLI agent-facing.**

### lavish-axi — **opt-in, oxe.bio/Bravus, nicho de artefato HTML.**
Editor local que abre HTML gerado por agente no browser, deixa anotar elementos/texto e
mandar feedback de volta, com layout-gate (esconde até o audit não achar overflow/texto
cortado). Instala como skill (`npx skills add`).

**Encaixe e limite:** cobre o loop de feedback visual em **artefatos HTML descartáveis**
(planos, comparações, mockups rápidos, dashboards, relatórios). **Não substitui o Pencil/
`.pen`** do Bravus (que é a ferramenta oficial de design de telas — regra do CLAUDE.md: usar
MCP pencil, nunca ler `.pen`). São nichos diferentes. **Adoção: baixa prioridade; opt-in
quando alguém quiser feedback visual preciso num artefato HTML.**

## Priorização

| Tool       | Encaixe                          | Prioridade | Racional |
|------------|----------------------------------|------------|----------|
| ponytail   | Todos os projetos                | **Alta**   | Preventivo, complementa Cerberus, -20% custo, risco ~0 |
| treehouse  | TheOrc (execução paralela)       | **Alta**   | Mata build-cache frio; casa com no-mistakes |
| axi        | Cerberus + TheOrc (referência)   | **Média**  | Adotar ao expor CLI a agente (`--format toon`) |
| lavish-axi | oxe/Bravus (HTML descartável)    | **Baixa**  | Nicho; não substitui Pencil |

## Consequences

- **Positivas:** todas MIT; as 3 kunchenguid combinam com o Cerberus por design; ponytail+
  Cerberus formam par preventivo↔corretivo que reduz custo composto; treehouse destrava a
  execução paralela do TheOrc.
- **Riscos:** dependência de binários de terceiros (mitigação: pin de versão, todos MIT,
  forkáveis); axi/lavish exigem trabalho próprio (CLI agent-facing / loop de design) para
  render valor — não é plug-and-play como o ponytail.

## Next steps

1. **Agora (Bravus):** instalar ponytail (plugin Claude Code) + setup do Cerberus — ver
   ADR-0001 e o guia de setup.
2. **TheOrc (dedicado):** spike de `treehouse` no fluxo de execução paralela; medir hit-rate
   do pool e ganho de tempo vs. worktree frio.
3. **Cerberus (quando houver CLI agent-facing):** avaliar `--format toon` no gate seguindo
   os princípios axi.
4. **Opt-in:** `lavish-axi` quando surgir necessidade de feedback visual em artefato HTML.
