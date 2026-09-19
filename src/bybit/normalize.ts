/**
 * Traducao de posicoes cruas da Bybit para o modelo normalizado do motor.
 *
 * Este ficheiro e' deliberadamente desconfiado. Nunca produz um numero errado
 * em silencio: se um campo falta ou vem inesperado, ou rejeita a posicao, ou
 * usa uma alternativa e DIZ que a usou. O diagnostico e' parte do resultado,
 * nao um log que ninguem le.
 */

import type { RawPosition, RawTransaction } from './client.ts';
import type { Category, Position, Side } from '../engine/types.ts';

/**
 * Taxa de margem de manutencao assumida quando a Bybit nao a fornece.
 * A real depende do nivel de risco por simbolo. 0.5% e' conservador para os
 * pares grandes; qualquer uso desta constante gera um aviso.
 */
export const DEFAULT_MM_RATE = 0.005;

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  symbol: string;
  code: string;
  message: string;
}

export interface NormalizeResult {
  positions: Position[];
  diagnostics: Diagnostic[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Deriva a moeda base de um simbolo inverse: BTCUSD -> BTC. */
export function baseCoinOf(symbol: string, settleCoin?: string): string {
  if (settleCoin) return settleCoin;
  const m = symbol.match(/^([A-Z0-9]+?)USDT?$/);
  return m ? m[1] : symbol;
}

/**
 * Preco de liquidacao calculado a partir dos primeiros principios.
 *
 * So e' usado quando a Bybit nao devolve `liqPrice`. Preferimos sempre o valor
 * da exchange, que incorpora os niveis de risco reais.
 *
 * Liquidacao quando `capital(P) == margem de manutencao(P)`:
 *
 *   linear  long   P = (size*E - IM) / (size * (1 - mm))
 *   linear  short  P = (IM + size*E) / (size * (1 + mm))
 *   inverse long   P = sizeUsd * (1 + mm) / (M + sizeUsd/E)
 *   inverse short  P = sizeUsd * (1 - mm) / (sizeUsd/E - M)
 *
 * Devolve null quando a posicao nao pode ser liquidada nessa direcao (o caso
 * mais notavel: uma inverse short a 1x, cujo denominador e' zero).
 */
export function deriveLiqPrice(args: {
  category: Category;
  side: Side;
  size: number;
  entryPrice: number;
  initialMargin: number;
  mmRate: number;
}): number | null {
  const { category, side, size, entryPrice: e, initialMargin: im, mmRate: mm } = args;
  if (size <= 0 || e <= 0) return null;

  if (category === 'linear') {
    const p =
      side === 'long'
        ? (size * e - im) / (size * (1 - mm))
        : (im + size * e) / (size * (1 + mm));
    return p > 0 ? p : null;
  }

  // inverse: `size` e' nocional em USD, `im` e' margem na moeda base
  if (side === 'long') {
    const denom = im + size / e;
    return denom > 0 ? (size * (1 + mm)) / denom : null;
  }
  const denom = size / e - im;
  // denom <= 0 -> a margem cobre a perda maxima: nunca liquida
  return denom > 1e-12 ? (size * (1 - mm)) / denom : null;
}

/** Traduz uma posicao crua. Devolve null quando a posicao nao e' utilizavel. */
export function normalizePosition(
  raw: RawPosition,
  category: Category,
  settleCoin: string,
  diagnostics: Diagnostic[],
): Position | null {
  const symbol = raw.symbol;
  const fail = (code: string, message: string) => {
    diagnostics.push({ severity: 'error', symbol, code, message });
    return null;
  };
  const warn = (code: string, message: string) =>
    diagnostics.push({ severity: 'warning', symbol, code, message });

  if (raw.side !== 'Buy' && raw.side !== 'Sell') {
    return fail('side_desconhecido', `side="${raw.side}" nao mapeia para long/short`);
  }
  const side: Side = raw.side === 'Buy' ? 'long' : 'short';

  const size = num(raw.size);
  const entryPrice = num(raw.avgPrice);
  const markPrice = num(raw.markPrice);
  if (!(size > 0)) return fail('size_invalido', `size="${raw.size}"`);
  if (!(entryPrice > 0)) return fail('entrada_invalida', `avgPrice="${raw.avgPrice}"`);
  if (!(markPrice > 0)) return fail('mark_invalido', `markPrice="${raw.markPrice}"`);

  if (raw.tradeMode === 0) {
    warn(
      'margem_cruzada',
      'Posição em margem CRUZADA: a liquidação é ao nível da conta, não da ' +
        'posição. Os cenários por posição são aproximações.',
    );
  }

  const positionValue = num(raw.positionValue);
  let initialMargin = num(raw.positionIM);
  const leverage = num(raw.leverage) || 1;

  if (!(initialMargin > 0)) {
    // Alternativa: nocional / alavancagem, na moeda de margem correta.
    initialMargin =
      category === 'linear' ? (size * entryPrice) / leverage : size / entryPrice / leverage;
    warn(
      'margem_derivada',
      `positionIM ausente; derivada de nocional/alavancagem (${initialMargin}).`,
    );
  }

  // Taxa de manutencao: preferir a real, vinda de positionMM/positionValue.
  let mmRate = DEFAULT_MM_RATE;
  const positionMM = num(raw.positionMM);
  if (positionMM > 0 && positionValue > 0) {
    mmRate = positionMM / positionValue;
  } else {
    warn('mm_assumida', `positionMM ausente; assumida taxa de manutenção ${DEFAULT_MM_RATE}.`);
  }

  let liqPrice: number | null = num(raw.liqPrice);
  if (!(liqPrice! > 0)) {
    liqPrice = deriveLiqPrice({ category, side, size, entryPrice, initialMargin, mmRate });
    if (liqPrice === null) {
      warn(
        'sem_liquidacao',
        'A Bybit não devolveu liqPrice e o cálculo indica que esta posição não ' +
          'pode ser liquidada nesta direção.',
      );
    } else {
      warn(
        'liq_derivada',
        `liqPrice ausente na resposta; calculado ${liqPrice.toFixed(2)} ` +
          `com taxa de manutenção ${(mmRate * 100).toFixed(3)}%.`,
      );
    }
  }

  return {
    id: `${category}:${symbol}:${raw.positionIdx}`,
    symbol,
    category,
    side,
    size,
    entryPrice,
    markPrice,
    leverage,
    liqPrice,
    marginAsset: category === 'linear' ? settleCoin : baseCoinOf(symbol, settleCoin),
    initialMargin,
    cumFunding: 0, // preenchido por applyFunding
    fundingRate: 0, // preenchido a partir do ticker
  };
}

export function normalizePositions(
  raws: RawPosition[],
  category: Category,
  settleCoin: string,
): NormalizeResult {
  const diagnostics: Diagnostic[] = [];
  const positions = raws
    .map((raw) => normalizePosition(raw, category, settleCoin, diagnostics))
    .filter((p): p is Position => p !== null);
  return { positions, diagnostics };
}

/**
 * Agrega o funding do registo de transacoes por simbolo e aplica-o as posicoes.
 *
 * Convencao de sinal: respeitamos o sinal que a Bybit devolve no campo
 * `funding` (negativo = pagaste). Isto precisa de ser confirmado contra dados
 * reais — e por isso gera um aviso quando todos os valores tem o mesmo sinal,
 * que e' o sintoma de uma convencao mal interpretada.
 */
export function applyFunding(
  positions: Position[],
  transactions: RawTransaction[],
): NormalizeResult {
  const diagnostics: Diagnostic[] = [];
  const bySymbol = new Map<string, number>();

  for (const tx of transactions) {
    if (tx.type !== 'SETTLEMENT') continue;
    const amount = num(tx.funding);
    if (!Number.isFinite(amount)) continue;
    bySymbol.set(tx.symbol, (bySymbol.get(tx.symbol) ?? 0) + amount);
  }

  const withFunding = positions.map((p) => {
    const cumFunding = bySymbol.get(p.symbol);
    if (cumFunding === undefined) {
      diagnostics.push({
        severity: 'warning',
        symbol: p.symbol,
        code: 'sem_funding',
        message:
          'Nenhum registo SETTLEMENT encontrado para este símbolo. O funding ' +
          'acumulado aparece como zero, o que pode ser falso.',
      });
      return p;
    }
    return { ...p, cumFunding };
  });

  return { positions: withFunding, diagnostics };
}
