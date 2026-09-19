# WealthTry

Painel pessoal para monitorizar posições abertas de perpétuos na Bybit e
simular cenários de preço, com foco em **distância à liquidação**.

Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) para as decisões e o porquê.

## Segurança — ler antes de tudo

- A chave da API da Bybit tem de ser **read-only**. Sem Trade. Sem Withdraw.
- Nunca comitar `.env`.
- Restringir a chave por IP sempre que possível.

## Ver a ferramenta a funcionar, já

Não é preciso ligar nenhuma conta. Há um portefólio sintético que replica a
configuração real (2 perpétuos linear + 2 inverse, margem isolada):

```bash
npm run report              # dados sintéticos
npm run report -- --bybit   # conta real (exige .env)
```

Mostra a tabela de posições com **alavancagem efetiva**, a fronteira de
liquidação, a escada de cenários e o funding acumulado e projetado.

## Sondar a API

A app já se diagnostica a si mesma (ver `Diagnostic` em
`src/data/source.ts`), por isso isto é opcional. Serve para inspecionar campos
crus que o normalizador não usa. **Corre na tua máquina**, não num ambiente
partilhado.

```bash
cp .env.example .env     # preenche BYBIT_API_KEY e BYBIT_API_SECRET
npm run probe            # saída completa, só para os teus olhos
npm run probe:safe       # valores mascarados -> probe-output.json, seguro para partilhar
```

`probe:safe` mantém a estrutura (nomes de campos, símbolos, long/short, isolada
vs cruzada) e substitui saldos e tamanhos por `<num>`. Distingue vazio de
preenchido de propósito — saber que um campo vem a `0` ou a `""` é exatamente a
informação de que precisamos.

O resumo no fim diz, por posição, se algum campo necessário ao motor de
cenários está em falta.

## Testes

```bash
npm test
```

O motor de cenários (`src/engine/`) é código puro sem I/O. É onde os bugs
custam dinheiro, por isso é onde os testes são levados a sério.

## Requisitos

Node >= 22.6 (usa type stripping nativo — sem build step).
