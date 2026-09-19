/**
 * Portefolio sintetico que replica a configuracao real: 2 perpetuos linear
 * (USDT-margined) e 2 inverse (coin-margined), todos em margem isolada e
 * alavancagem baixa.
 *
 * Os dados sao RawPosition, de proposito: passam pelo mesmo normalizador que a
 * API real, e o liqPrice e' CALCULADO em vez de escrito a mao. Assim os numeros
 * nunca podem estar internamente inconsistentes, e o caminho exercitado aqui e'
 * o mesmo que corre em producao.
 */

import type { RawPosition, RawTransaction } from '../bybit/client.ts';
import type { Category } from '../engine/types.ts';
import { applyFunding, normalizePositions } from '../bybit/normalize.ts';
import type { DataSource, PortfolioSnapshot } from './source.ts';

interface Group {
  category: Category;
  settleCoin: string;
  positions: RawPosition[];
}

const T0 = '1735689600000'; // 2025-01-01

/** liqPrice vazio de proposito: queremos que o normalizador o derive. */
function rawPosition(p: {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
  markPrice: string;
  leverage: string;
  positionIM: string;
  positionValue: string;
  positionMM: string;
  unrealisedPnl: string;
}): RawPosition {
  return {
    ...p,
    liqPrice: '',
    curRealisedPnl: '0',
    tradeMode: 1, // isolada
    positionIdx: 0,
    createdTime: T0,
    updatedTime: T0,
  };
}

export const FIXTURE_GROUPS: Group[] = [
  {
    category: 'linear',
    settleCoin: 'USDT',
    positions: [
      rawPosition({
        symbol: 'BTCUSDT',
        side: 'Buy',
        size: '0.15',
        avgPrice: '95000',
        markPrice: '92000',
        leverage: '2',
        positionIM: '7125',
        positionValue: '13800',
        positionMM: '69',
        unrealisedPnl: '-450',
      }),
      rawPosition({
        symbol: 'ETHUSDT',
        side: 'Sell',
        size: '3',
        avgPrice: '3200',
        markPrice: '3350',
        leverage: '3',
        positionIM: '3200',
        positionValue: '10050',
        positionMM: '50.25',
        unrealisedPnl: '-450',
      }),
    ],
  },
  {
    category: 'inverse',
    settleCoin: 'BTC',
    positions: [
      rawPosition({
        symbol: 'BTCUSD',
        side: 'Buy',
        size: '8000', // nocional em USD
        avgPrice: '94000',
        markPrice: '92000',
        leverage: '2',
        positionIM: '0.04255319', // BTC
        positionValue: '0.08695652',
        positionMM: '0.00043478',
        unrealisedPnl: '-0.00185',
      }),
    ],
  },
  {
    category: 'inverse',
    settleCoin: 'ETH',
    positions: [
      rawPosition({
        symbol: 'ETHUSD',
        side: 'Buy',
        size: '5000',
        avgPrice: '3050',
        markPrice: '3350',
        leverage: '2',
        positionIM: '0.81967213', // ETH
        positionValue: '1.49253731',
        positionMM: '0.00746269',
        unrealisedPnl: '0.14681',
      }),
    ],
  },
];

/** Taxas de funding por 8h. Valores plausiveis, nao reais. */
const FUNDING_RATES: Record<string, number> = {
  BTCUSDT: 0.0001,
  ETHUSDT: -0.00005,
  BTCUSD: 0.00012,
  ETHUSD: 0.00008,
};

const FIXTURE_TRANSACTIONS: RawTransaction[] = [
  { symbol: 'BTCUSDT', funding: '-18.40' },
  { symbol: 'ETHUSDT', funding: '6.15' },
  { symbol: 'BTCUSD', funding: '-0.00042' },
  { symbol: 'ETHUSD', funding: '-0.0193' },
].map((t) => ({
  ...t,
  category: 'linear',
  currency: 'USDT',
  type: 'SETTLEMENT',
  change: t.funding,
  cashFlow: '0',
  transactionTime: T0,
}));

export class FixtureSource implements DataSource {
  readonly name = 'fixture';

  async fetchPortfolio(): Promise<PortfolioSnapshot> {
    const positions = [];
    const diagnostics = [];

    for (const group of FIXTURE_GROUPS) {
      const result = normalizePositions(group.positions, group.category, group.settleCoin);
      positions.push(...result.positions);
      diagnostics.push(...result.diagnostics);
    }

    const withRates = positions.map((p) => ({
      ...p,
      fundingRate: FUNDING_RATES[p.symbol] ?? 0,
    }));
    const funded = applyFunding(withRates, FIXTURE_TRANSACTIONS);

    return {
      fetchedAt: new Date().toISOString(),
      source: this.name,
      positions: funded.positions,
      diagnostics: [...diagnostics, ...funded.diagnostics],
    };
  }
}
