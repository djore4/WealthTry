/**
 * Emite o payload que a interface consome, calculado pelo motor real.
 *
 * Existe para que a UI nunca reimplemente matemática de risco. A página recebe
 * cenários já calculados e limita-se a formatar e a indexar.
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
import { FixtureSource } from '../src/data/fixtures.ts';

const snapshot = await new FixtureSource().fetchPortfolio();
const ps = snapshot.positions;

const frontier = liquidationFrontier(ps);
const base = ps.reduce((s, p) => s + marginUsd(p, p.markPrice), 0);

// -60% a +60% em passos de 1%: resolução suficiente para o slider parecer contínuo.
const scenarios = [];
for (let i = -60; i <= 60; i++) {
  const move = i / 100;
  const r = evaluateScenario(ps, move);
  scenarios.push({
    move,
    pnlUsd: r.totals.pnlUsd,
    equityUsd: r.totals.equityUsd,
    capitalLossPct: r.totals.capitalLossPct,
    legs: r.legs.map((l) => ({
      symbol: l.position.symbol,
      price: l.price,
      pnlUsd: l.liquidated ? -marginUsd(l.position, l.position.markPrice) : l.pnlUsd,
      equityUsd: l.equityUsd,
      liquidated: l.liquidated,
    })),
  });
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: snapshot.source,
  baseCapitalUsd: base,
  // Câmbio fixo no protótipo. Em produção vem de uma fonte de câmbio.
  eurPerUsd: 0.92,
  positions: ps.map((p) => ({
    symbol: p.symbol,
    category: p.category,
    side: p.side,
    leverage: p.leverage,
    effectiveLeverage: effectiveLeverage(p),
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    liqPrice: p.liqPrice,
    liqMove: liqMove(p),
    marginAsset: p.marginAsset,
    marginUsd: marginUsd(p, p.markPrice),
    pnlUsd: pnlUsd(p, p.markPrice),
    equityUsd: equityUsd(p, p.markPrice),
    fundingPaidUsd: fundingPaidUsd(p, p.markPrice),
    fundingRate: p.fundingRate,
    funding30dUsd: projectedFundingUsd(p, 30, p.markPrice),
  })),
  frontier: {
    down: frontier.down && { move: frontier.down.move, symbol: frontier.down.position.symbol },
    up: frontier.up && { move: frontier.up.move, symbol: frontier.up.position.symbol },
  },
  scenarios,
  diagnostics: snapshot.diagnostics,
};

console.log(JSON.stringify(payload));
