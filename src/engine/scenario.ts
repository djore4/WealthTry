/**
 * Motor de cenarios. Funcoes puras, zero I/O, zero dependencias.
 *
 * Toda a matematica que pode custar dinheiro vive aqui, isolada e testada.
 *
 * A distincao que domina este ficheiro:
 *   - linear  (USDT-margined): margem em USDT, PnL em USDT. USDT ~ USD.
 *   - inverse (coin-margined): margem na moeda base, PnL na moeda base.
 *     A margem e' o proprio ativo que estas a negociar, por isso o valor em USD
 *     do teu colateral move-se com o preco. E' dai que vem toda a assimetria.
 */

import type {
  LiquidationFrontier,
  Position,
  PositionOutcome,
  ScenarioResult,
} from './types.ts';

const dir = (p: Position): number => (p.side === 'long' ? 1 : -1);

/** Nocional da posicao em USD, ao preco dado. */
export function notionalUsd(p: Position, price: number): number {
  return p.category === 'linear' ? p.size * price : p.size;
}

/**
 * PnL na moeda de margem.
 *   linear:  size * (P - E)            -> linear no preco
 *   inverse: size * (1/E - 1/P)        -> NAO linear no preco
 */
export function pnlNative(p: Position, price: number): number {
  if (price <= 0) throw new RangeError(`preco invalido: ${price}`);
  if (p.category === 'linear') {
    return p.size * (price - p.entryPrice) * dir(p);
  }
  return p.size * (1 / p.entryPrice - 1 / price) * dir(p);
}

/**
 * PnL em USD, ao preco do cenario.
 *
 * Para inverse, o PnL e' em moeda e tem de ser valorizado ao preco do cenario.
 * Curiosidade que vale a pena saber: o resultado simplifica para
 * `size * (P/E - 1)`, ou seja, identico a uma linear de nocional equivalente.
 * Em PnL puro NAO ha penalizacao no inverse. A penalizacao esta na margem.
 */
export function pnlUsd(p: Position, price: number): number {
  const native = pnlNative(p, price);
  return p.category === 'linear' ? native : native * price;
}

/**
 * Margem valorizada em USD ao preco do cenario.
 *
 * Aqui esta a assimetria do inverse: a margem esta na moeda, por isso cai
 * ao mesmo tempo que a posicao perde. Numa linear, a margem em USDT nao mexe.
 */
export function marginUsd(p: Position, price: number): number {
  return p.category === 'linear' ? p.initialMargin : p.initialMargin * price;
}

export function isLiquidated(p: Position, price: number): boolean {
  if (p.liqPrice === null || p.liqPrice <= 0) return false;
  return p.side === 'long' ? price <= p.liqPrice : price >= p.liqPrice;
}

/** Capital restante da posicao em USD. Uma posicao liquidada vale zero. */
export function equityUsd(p: Position, price: number): number {
  if (isLiquidated(p, price)) return 0;
  return Math.max(0, marginUsd(p, price) + pnlUsd(p, price));
}

/** Funding acumulado desde a abertura, em USD ao preco dado. */
export function fundingPaidUsd(p: Position, price: number): number {
  return p.category === 'linear' ? p.cumFunding : p.cumFunding * price;
}

/**
 * Custo determinístico de manter a posicao mais N dias, em USD.
 * Negativo = pagas. Positivo = recebes.
 *
 * Assume a taxa de funding atual constante e 3 intervalos de 8h por dia.
 * Nao e' previsao: e' aritmetica sobre a taxa que existe agora.
 */
export function projectedFundingUsd(p: Position, days: number, price: number): number {
  const intervals = days * 3;
  return -dir(p) * p.fundingRate * intervals * notionalUsd(p, price);
}

/**
 * Movimento de preco, em fracao, entre o mark atual e a liquidacao.
 * Long -> negativo. Short -> positivo.
 */
export function liqMove(p: Position): number | null {
  if (p.liqPrice === null || p.liqPrice <= 0 || p.markPrice <= 0) return null;
  return p.liqPrice / p.markPrice - 1;
}

/**
 * Alavancagem efetiva: quantos "x" de movimento adverso aguentas ate zero.
 *
 * Definicao: 1 / |movimento ate a liquidacao|.
 *
 * E' este numero, e nao o da exchange, que descreve o teu risco real. Uma
 * linear long a 1x liquida a -100% (efetiva 1x). Uma inverse long a 1x liquida
 * a -50% (efetiva 2x). Mesmo numero no ecra da Bybit, risco a dobrar.
 */
export function effectiveLeverage(p: Position): number | null {
  const m = liqMove(p);
  if (m === null || m === 0) return null;
  return 1 / Math.abs(m);
}

/** Resolve o movimento a aplicar a um simbolo. */
function moveFor(p: Position, moves: number | Record<string, number>): number {
  if (typeof moves === 'number') return moves;
  return moves[p.symbol] ?? 0;
}

/**
 * Avalia um cenario.
 *
 * `moves` pode ser um numero unico (todos os ativos movem-se igual — o
 * pressuposto de correlacao perfeita, que e' o caso de stress honesto para
 * cripto) ou um mapa simbolo -> movimento para sobrepor caso a caso.
 */
export function evaluateScenario(
  positions: Position[],
  moves: number | Record<string, number>,
): ScenarioResult {
  const legs: PositionOutcome[] = positions.map((position) => {
    const move = moveFor(position, moves);
    const price = position.markPrice * (1 + move);
    const liquidated = isLiquidated(position, price);
    return {
      position,
      price,
      move,
      pnlNative: pnlNative(position, price),
      pnlUsd: pnlUsd(position, price),
      marginUsd: marginUsd(position, price),
      equityUsd: equityUsd(position, price),
      liquidated,
    };
  });

  // Capital de referencia: a margem avaliada ao preco ATUAL, nao ao do cenario.
  // E' o que tens hoje e que arriscas perder.
  const baseCapital = positions.reduce((s, p) => s + marginUsd(p, p.markPrice), 0);
  const equity = legs.reduce((s, l) => s + l.equityUsd, 0);

  return {
    moves: Object.fromEntries(legs.map((l) => [l.position.symbol, l.move])),
    legs,
    totals: {
      pnlUsd: legs.reduce((s, l) => s + (l.liquidated ? 0 : l.pnlUsd), 0),
      marginUsd: legs.reduce((s, l) => s + l.marginUsd, 0),
      equityUsd: equity,
      liquidatedCount: legs.filter((l) => l.liquidated).length,
      capitalLossPct: baseCapital > 0 ? 1 - equity / baseCapital : 0,
    },
  };
}

/**
 * O numero que muda decisoes: a que movimento acontece a PRIMEIRA liquidacao,
 * em cada direcao, e qual a posicao responsavel.
 */
export function liquidationFrontier(positions: Position[]): LiquidationFrontier {
  let down: LiquidationFrontier['down'] = null;
  let up: LiquidationFrontier['up'] = null;

  for (const position of positions) {
    const move = liqMove(position);
    if (move === null) continue;
    if (move < 0) {
      if (down === null || move > down.move) down = { move, position };
    } else if (move > 0) {
      if (up === null || move < up.move) up = { move, position };
    }
  }

  return { down, up };
}
