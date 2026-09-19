/**
 * Relatório de terminal sobre o portefólio. Corre o motor de cenários de ponta
 * a ponta e mostra o que a interface web vai mostrar.
 *
 * Serve dois propósitos: verificar a integração engine + dados sem browser, e
 * tornar o valor da ferramenta visível antes de existir UI.
 *
 *   npm run report            # dados sintéticos
 *   npm run report -- --bybit # conta real (exige .env e rede para a Bybit)
 */

import {
  effectiveLeverage,
  equityUsd,
  evaluateScenario,
  fundingPaidUsd,
  liqMove,
  liquidationFrontier,
  marginUsd,
  pnlUsd,
  projectedFundingUsd,
} from '../src/engine/scenario.ts';
import type { Position } from '../src/engine/types.ts';
import { FixtureSource } from '../src/data/fixtures.ts';
import { BybitSource } from '../src/data/bybit-source.ts';
import type { DataSource, PortfolioSnapshot } from '../src/data/source.ts';
import { readFileSync } from 'node:fs';

// --- formatação -------------------------------------------------------------

const usd = (n: number, digits = 2) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;

const pct = (n: number, digits = 1) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`;
const px = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const L = (s: string, w: number) => s.padEnd(w).slice(0, w);
const R = (s: string, w: number) => s.padStart(w).slice(-w);

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

const sign = (n: number, s: string) => (n < 0 ? `${RED}${s}${OFF}` : `${GREEN}${s}${OFF}`);
const rule = (w = 104) => DIM + '─'.repeat(w) + OFF;

function heading(text: string) {
  console.log(`\n${BOLD}${text}${OFF}`);
  console.log(rule());
}

// --- secções ----------------------------------------------------------------

function positionsTable(positions: Position[]) {
  heading('POSIÇÕES ABERTAS');
  console.log(
    DIM +
      L('SÍMBOLO', 9) + L('CATEGORIA', 10) + L('LADO', 7) +
      R('NOM.', 5) + R('EFET.', 7) + R('ENTRADA', 11) + R('MARK', 11) +
      R('LIQ.', 11) + R('ATÉ LIQ.', 10) + R('PnL USD', 12) + R('MARGEM', 11) +
      OFF,
  );

  for (const p of positions) {
    const move = liqMove(p);
    const eff = effectiveLeverage(p);
    const pnl = pnlUsd(p, p.markPrice);
    // Um "até liquidação" estreito é a informação mais urgente da tabela.
    const distColour = move === null ? DIM : Math.abs(move) < 0.2 ? RED : Math.abs(move) < 0.35 ? YELLOW : GREEN;

    console.log(
      L(p.symbol, 9) +
        L(p.category === 'inverse' ? 'inverse' : 'linear', 10) +
        L(p.side, 7) +
        R(`${p.leverage}x`, 5) +
        R(eff === null ? '—' : `${eff.toFixed(2)}x`, 7) +
        R(px(p.entryPrice), 11) +
        R(px(p.markPrice), 11) +
        R(p.liqPrice === null ? 'nunca' : px(p.liqPrice), 11) +
        distColour + R(move === null ? '—' : pct(move), 10) + OFF +
        sign(pnl, R(usd(pnl), 12)) +
        R(usd(marginUsd(p, p.markPrice), 0), 11),
    );
  }

  const equity = positions.reduce((s, p) => s + equityUsd(p, p.markPrice), 0);
  const margin = positions.reduce((s, p) => s + marginUsd(p, p.markPrice), 0);
  const pnl = positions.reduce((s, p) => s + pnlUsd(p, p.markPrice), 0);
  console.log(rule());
  console.log(
    `${BOLD}Capital em risco${OFF} ${usd(margin, 0)}   ` +
      `${BOLD}PnL não realizado${OFF} ${sign(pnl, usd(pnl))}   ` +
      `${BOLD}Equity${OFF} ${usd(equity, 0)}`,
  );

  // A alavancagem nominal e a efetiva divergirem é o achado central do projeto.
  const divergent = positions.filter((p) => {
    const eff = effectiveLeverage(p);
    return eff !== null && eff > p.leverage * 1.15;
  });
  if (divergent.length > 0) {
    console.log(
      `\n${YELLOW}⚠${OFF}  ${divergent.length} posição(ões) com alavancagem efetiva ` +
        `acima da nominal ${DIM}(medida a partir do preço de HOJE, não da entrada)${OFF}:`,
    );
    for (const p of divergent) {
      const causa =
        p.category === 'inverse'
          ? 'colateral na própria moeda'
          : 'a posição já está contra ti';
      console.log(
        `   ${p.symbol} diz ${p.leverage}x na Bybit, mas liquida a ` +
          `${pct(liqMove(p)!)} daqui — risco real de ` +
          `${BOLD}${effectiveLeverage(p)!.toFixed(2)}x${OFF} ${DIM}(${causa})${OFF}.`,
      );
    }
  }
}

function frontier(positions: Position[]) {
  heading('FRONTEIRA DE LIQUIDAÇÃO');
  const f = liquidationFrontier(positions);

  for (const [label, hit] of [['queda', f.down], ['subida', f.up]] as const) {
    if (!hit) {
      console.log(`Numa ${label}, nenhuma posição liquida.`);
      continue;
    }
    const scenario = evaluateScenario(positions, hit.move);
    console.log(
      `Numa ${label}, a primeira liquidação acontece a ${BOLD}${pct(hit.move)}${OFF} ` +
        `(${hit.position.symbol}).`,
    );
    const loss = scenario.totals.capitalLossPct;
    const verb =
      loss > 0
        ? `perdes ${BOLD}${RED}${(loss * 100).toFixed(1)}%${OFF} do capital`
        : `ganhas ${BOLD}${GREEN}${(-loss * 100).toFixed(1)}%${OFF} sobre o capital`;
    console.log(
      `   Nesse ponto ${verb} e ficam ` +
        `${scenario.totals.liquidatedCount} posição(ões) liquidadas.`,
    );
  }
}

function ladder(positions: Position[]) {
  heading('CENÁRIOS  (todos os ativos movem-se em conjunto — pressuposto de correlação perfeita)');
  console.log(
    DIM + R('MOVIMENTO', 10) + R('PnL USD', 14) + R('EQUITY', 13) +
      R('CAPITAL', 10) + '   LIQUIDADAS' + OFF,
  );

  for (const move of [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4]) {
    const s = evaluateScenario(positions, move);
    const loss = s.totals.capitalLossPct;
    const liq = s.totals.liquidatedCount;
    const names = s.legs.filter((l) => l.liquidated).map((l) => l.position.symbol);
    const marker = move === 0 ? `${DIM} ← hoje${OFF}` : '';

    console.log(
      R(pct(move, 0), 10) +
        sign(s.totals.pnlUsd, R(usd(s.totals.pnlUsd, 0), 14)) +
        R(usd(s.totals.equityUsd, 0), 13) +
        (loss > 0 ? RED : GREEN) + R(pct(-loss, 0), 10) + OFF +
        '   ' + (liq ? `${RED}${names.join(', ')}${OFF}` : `${DIM}—${OFF}`) +
        marker,
    );
  }
}

function funding(positions: Position[]) {
  heading('FUNDING');
  let paid = 0;
  let next30 = 0;

  for (const p of positions) {
    const already = fundingPaidUsd(p, p.markPrice);
    const projected = projectedFundingUsd(p, 30, p.markPrice);
    paid += already;
    next30 += projected;
    console.log(
      L(p.symbol, 9) +
        `desde a abertura ${sign(already, R(usd(already), 10))}   ` +
        `taxa ${R((p.fundingRate * 100).toFixed(4) + '%', 9)}/8h   ` +
        `próximos 30 dias ${sign(projected, R(usd(projected), 10))}`,
    );
  }

  console.log(rule());
  console.log(
    `${BOLD}Total pago/recebido${OFF} ${sign(paid, usd(paid))}   ` +
      `${BOLD}Manter mais 30 dias${OFF} ${sign(next30, usd(next30))}` +
      `${DIM}  (taxa atual constante — aritmética, não previsão)${OFF}`,
  );
}

function diagnostics(snapshot: PortfolioSnapshot) {
  if (snapshot.diagnostics.length === 0) return;
  heading('DIAGNÓSTICO DA CAMADA DE DADOS');
  for (const d of snapshot.diagnostics) {
    const tag = d.severity === 'error' ? `${RED}ERRO${OFF}` : `${YELLOW}AVISO${OFF}`;
    console.log(`${tag}  ${L(d.symbol, 16)} ${DIM}[${d.code}]${OFF} ${d.message}`);
  }
}

// --- arranque ---------------------------------------------------------------

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .env é opcional */
  }
}

function buildSource(): DataSource {
  if (!process.argv.includes('--bybit')) return new FixtureSource();

  loadEnv();
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error('--bybit exige BYBIT_API_KEY e BYBIT_API_SECRET em .env');
    process.exit(1);
  }
  return new BybitSource({
    apiKey,
    apiSecret,
    testnet: process.env.BYBIT_TESTNET === 'true',
    linearSettleCoins: (process.env.BYBIT_LINEAR_SETTLE || 'USDT').split(','),
    inverseSettleCoins: (process.env.BYBIT_INVERSE_SETTLE || 'BTC,ETH').split(','),
  });
}

const source = buildSource();
const snapshot = await source.fetchPortfolio();

console.log(
  `\n${BOLD}WealthTry${OFF} ${DIM}· fonte: ${snapshot.source} · ${snapshot.fetchedAt}${OFF}`,
);
if (snapshot.source === 'fixture') {
  console.log(`${YELLOW}Dados sintéticos.${OFF} Corre com --bybit para usar a conta real.`);
}

if (snapshot.positions.length === 0) {
  console.log('\nSem posições abertas.');
} else {
  positionsTable(snapshot.positions);
  frontier(snapshot.positions);
  ladder(snapshot.positions);
  funding(snapshot.positions);
}
diagnostics(snapshot);
console.log();
