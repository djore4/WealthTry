# WealthTry — Arquitetura

Registo das decisões tomadas e, mais importante, **porquê**. Se daqui a seis
meses discordares de alguma, este ficheiro diz-te contra o que estás a discutir.

## Âmbito da v1

Painel pessoal para monitorizar posições **abertas** de perpétuos na Bybit e
simular cenários de preço, com foco em **distância à liquidação**.

**Explicitamente fora da v1:**

| Fora | Porquê | Quando |
|---|---|---|
| Motor de recomendações | Não se recomenda em cima de dados que ainda não lemos com fiabilidade. Um recomendador caseiro mal calibrado, com alavancagem, amplifica vieses e apresenta-os como análise. | Depois de o painel existir e ser de confiança |
| Histórico de trades fechados | Exige ingestão incremental (a API da Bybit só expõe uma janela de histórico). Não é preciso para monitorizar 4-5 posições abertas. | v2 |
| Eixo temporal nos cenários | Exigiria simular trajetórias de preço (Monte Carlo/GBM). Traz *model risk* e **falsa precisão** — um "68% de probabilidade" que é palpite vestido de matemática. Perigoso com alavancagem. | v2, se alguma vez |
| Ações, fundos, PPR | Foco primeiro onde está o capital de risco. | Futuro |

O valor do tempo entra na v1 pela via honesta: **projeção determinística de
funding** ("manter mais 30 dias custa X"). É aritmética sobre a taxa atual, não
é previsão.

## Stack

```
Browser / PWA (telemóvel + desktop)  ──  Next.js · React · Tailwind
         │  nunca vê as chaves da Bybit
         │  sessão autenticada
Next.js Server (Vercel)
         │  /api/portfolio → lê Bybit, normaliza para USD
         │  motor de cenários (puro, testável)
         │  escreve snapshot
         ├──────────────► Bybit API v5 (READ-ONLY, IP whitelist)
         └──────────────► Supabase (auth · chaves cifradas · snapshots)
```

### Regras não negociáveis

1. **Chave Bybit read-only.** Sem permissões de trade nem de levantamento.
   Mesmo que vaze, ninguém negoceia. É a proteção principal.
2. **As chaves nunca chegam ao browser.** Todas as chamadas à Bybit passam
   pelo servidor. Chamar a Bybit do frontend expõe as chaves a qualquer pessoa.
3. **IP whitelist.** O servidor cloud tem IP de saída fixo — registá-lo na
   Bybit torna a chave inútil fora dali. (Este é um argumento *a favor* da
   cloud face a uma máquina doméstica com IP dinâmico.)
4. **A app tem login.** Está na internet pública; sem autenticação, quem
   descobrir o URL vê o portefólio.
5. **O motor de cenários é puro.** Sem I/O, sem rede. Recebe posições, devolve
   resultados. É aqui que os bugs custam dinheiro, por isso é aqui que os
   testes são levados a sério.
6. **A camada Bybit é fina e isolada.** Se a API mudar, muda um ficheiro.

## Modelo de dados (Supabase)

Deliberadamente mínimo. **Não guardamos trades.** As posições abertas são lidas
ao vivo; os cenários são matemática por cima desses números.

- `api_credentials` — chave Bybit cifrada. Uma linha.
- `portfolio_snapshots` — `timestamp`, equity total USD, PnL, e o JSON das
  posições nesse instante.

Snapshots são escritos **quando abres a app** e também **de hora a hora por
cron**, porque um histórico que só existe quando te lembras de olhar tem
buracos precisamente nos momentos que interessam (a queda a meio da noite).

## A matemática que justifica o projeto

Se a ferramenta só repetisse os números da Bybit num ecrã mais bonito, não
valia o esforço. O que vale é **normalizar para uma moeda de referência e expor
a exposição real**. Há duas matemáticas diferentes em jogo:

**Linear (USDT-margined):** margem em USDT, PnL em USDT, linear no preço.

**Inverse (coin-margined):** o contrato é denominado em USD, mas margem e PnL
são na moeda base. `PnL_moeda = contratos × (1/entrada − 1/P)` — não linear.

### Onde está mesmo a assimetria

Em **PnL convertido para USD, inverse e linear são equivalentes**:
`contratos × (1/E − 1/P) × P = contratos × (P/E − 1)`. Não há penalização aqui.

A assimetria está no **colateral**. A margem de uma inverse está na moeda que
estás a negociar, por isso desvaloriza ao mesmo tempo que a posição perde:

> Uma **linear long a 1x nunca liquida**.
> Uma **inverse long a 1x liquida a −50%.**
> Mesmo número no ecrã da Bybit, risco a dobrar.

Daí o indicador **alavancagem efetiva** = `1 / |movimento até à liquidação|`,
**medido a partir do preço de hoje, não da entrada** — é o risco que corres a
partir de agora, que é a pergunta relevante.

Movimento de preço até à liquidação, sem margem de manutenção
(verificado em `src/bybit/normalize.test.ts`):

| Alavancagem | linear | inverse |
|---|---|---|
| 1x long | nunca (exigiria preço zero) | **−50%** |
| 1x short | +100% | **nunca** |
| 2x long | −50% | **−33%** |
| 2x short | +50% | **+100%** |

A leitura que interessa: **inverse long é sempre pior que linear; inverse short
é sempre melhor.** Nenhuma destas assimetrias aparece no número de alavancagem
que a exchange mostra. Quem corre as duas categorias ao mesmo tempo, como nós,
tem duas escalas de risco diferentes a chamarem-se "2x".

### Pressuposto de correlação

O slider mestre move todos os ativos na mesma percentagem. Cripto é altamente
correlacionada, por isso é o caso de stress honesto — mas **é um pressuposto, e
vai estar escrito no ecrã**, com override por ativo. Uma ferramenta que esconde
os seus pressupostos é perigosa.

## Achados que vieram de construir (não de planear)

**O funding não está no objeto de posição.** `curRealisedPnl` é PnL realizado
com taxas de negociação, não funding. O indicador obrigatório "funding
pago/recebido desde a abertura" exige agregar o registo de transações
(`/v5/account/transaction-log`, `type=SETTLEMENT`) — outro endpoint, outra
paginação, outra janela temporal. Custo real que o plano inicial não previa.

**Somar o PnL de cada posição num cenário produz números absurdos.** Uma
posição liquidada deixa de ter PnL, e o total "melhorava" quando o mercado
piorava: −5.700 USD a −30% e −2.400 USD a −40%. A definição correta de PnL de
cenário é `equity do cenário − capital de hoje`, que é monótona e inclui
automaticamente a desvalorização do colateral das inverse. Está fechado com um
teste de propriedade em `src/engine/scenario.test.ts`.

Nenhum dos dois apareceu ao desenhar. Apareceram ao executar.

## Como se constrói sem a conta ligada

A camada de dados é uma interface `DataSource` com duas implementações:

- `FixtureSource` — portefólio sintético que replica a configuração real
  (2 linear + 2 inverse, isolada, alavancagem baixa).
- `BybitSource` — a API real.

**Ambas passam pelo mesmo normalizador.** As fixtures são `RawPosition`, tal
como a API as devolve, e o `liqPrice` é *calculado* em vez de escrito à mão —
por isso não podem ficar internamente inconsistentes, e o caminho exercitado
com dados sintéticos é o mesmo que corre em produção.

Consequência prática: **a aplicação inteira é construível e verificável sem
tocar na conta.** Não é um andaime temporário; é o que permite testar a UI
contra cenários extremos que a conta real não tem.

O diagnóstico substitui o script de sondagem manual: `PortfolioSnapshot` traz
um array de `Diagnostic` que é **mostrado ao utilizador**, não enterrado num
log. Na primeira ligação à conta real, a app diz o que mapeou e o que assumiu.

## UX

Pressuposto de partida: **abres isto no telemóvel, frequentemente num momento
de ansiedade, e queres uma resposta em 2 segundos.** Tudo se subordina a isso.

- **Estado** — equity, PnL e o indicador de risco (menor distância à liquidação
  de todas as posições) no topo. Depois um cartão por posição com uma *pista de
  liquidação*: barra horizontal a mostrar onde está o preço atual entre entrada
  e liquidação. Vê-se sem ler números.
- **Cenários** — slider grande na zona do polegar (−50% a +50%), presets de
  volatilidade e de stress. Recalcula ao vivo, com selo **LIQUIDADO** quando
  uma posição cruza. E o número que muda decisões:
  *"A primeira liquidação acontece a −18,4% (BTCUSD). Aí perdes 34% do capital."*
  Com 4 posições correlacionadas e matemática inverse pelo meio, isto não é
  calculável de cabeça.
- **Histórico** — equity ao longo do tempo, honesto sobre os buracos.

Transversal: moeda base **USD com toggle para €**, modo dia/noite, e **modo
ocultar valores** (para olhar para o telemóvel em público).

## Estado atual

- [x] Motor de cenários + testes (`src/engine/`) — 38 testes
- [x] Cliente Bybit v5 read-only (`src/bybit/client.ts`)
- [x] Normalizador com diagnósticos e cálculo de liquidação (`src/bybit/normalize.ts`)
- [x] `DataSource`: fixtures + Bybit (`src/data/`)
- [x] Relatório de terminal de ponta a ponta (`npm run report`)
- [x] Script de sondagem autónomo (`scripts/probe-bybit.mjs`)
- [ ] Supabase: auth, schema, cifra das chaves
- [ ] Next.js: Estado, Cenários, Histórico
- [ ] Deploy Vercel + IP whitelist na Bybit
- [ ] Confirmar contra a conta real: `tradeMode`, presença de `liqPrice`,
      e a convenção de sinal do campo `funding`

### Pendente de verificação contra dados reais

O código assume e **avisa quando assume**:

| Pressuposto | Onde | Como se confirma |
|---|---|---|
| `funding` negativo = pago | `applyFunding` | Comparar com o extrato da Bybit |
| Taxa de manutenção 0,5% quando ausente | `DEFAULT_MM_RATE` | Usar `positionMM` real |
| Janela de 30 dias no registo de funding | `BybitSource` | Posições mais antigas ficam subestimadas |
