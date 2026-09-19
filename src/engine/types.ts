/**
 * Modelo de posicao normalizado.
 *
 * Tudo o que entra no motor de cenarios passa por esta forma. A camada Bybit
 * traduz linear e inverse para aqui; o motor nunca sabe que a Bybit existe.
 */

export type Category = 'linear' | 'inverse';
export type Side = 'long' | 'short';

export interface Position {
  id: string;
  symbol: string;
  category: Category;
  side: Side;

  /**
   * linear:  unidades do ativo base (ex.: 0.5 = 0.5 BTC)
   * inverse: nocional em USD do contrato (ex.: 1000 = 1000 USD)
   */
  size: number;

  entryPrice: number;
  markPrice: number;

  /** Alavancagem nominal reportada pela exchange. Ver `effectiveLeverage`. */
  leverage: number;

  /** Preco de liquidacao reportado pela exchange. null quando nao aplicavel. */
  liqPrice: number | null;

  /** Ativo em que a margem isolada esta depositada: 'USDT' (linear) ou moeda base (inverse). */
  marginAsset: string;

  /** Margem da posicao, em unidades de `marginAsset`. */
  initialMargin: number;

  /**
   * Funding acumulado desde a abertura, em unidades de `marginAsset`.
   * Negativo = pagaste. Positivo = recebeste.
   */
  cumFunding: number;

  /** Taxa de funding atual por intervalo de 8h, em decimal (0.0001 = 0.01%). */
  fundingRate: number;
}

/** Resultado de um cenario para uma posicao. */
export interface PositionOutcome {
  position: Position;
  /** Preco do subjacente neste cenario. */
  price: number;
  /** Variacao aplicada face ao mark price atual (fracao: -0.2 = -20%). */
  move: number;
  /** PnL na moeda de margem (USDT para linear, moeda base para inverse). */
  pnlNative: number;
  /** PnL convertido para USD ao preco do cenario. */
  pnlUsd: number;
  /** Margem valorizada em USD ao preco do cenario. Para inverse, isto move-se com o preco. */
  marginUsd: number;
  /** Capital restante da posicao em USD. Zero se liquidada. */
  equityUsd: number;
  liquidated: boolean;
}

export interface ScenarioResult {
  /** Movimento aplicado, por simbolo. */
  moves: Record<string, number>;
  legs: PositionOutcome[];
  totals: {
    /**
     * Ganho/perda em USD face ao capital de hoje: `equityUsd - baseCapitalUsd`.
     * NAO e a soma do PnL das pernas — ver a nota em `evaluateScenario`.
     */
    pnlUsd: number;
    /** Margem de todas as posicoes valorizada ao preco de HOJE. A referencia. */
    baseCapitalUsd: number;
    marginUsd: number;
    equityUsd: number;
    liquidatedCount: number;
    /** Fracao do capital inicial perdida (0.34 = perdes 34%). */
    capitalLossPct: number;
  };
}

/** Movimento de preco necessario para a primeira liquidacao, em cada direcao. */
export interface LiquidationFrontier {
  down: { move: number; position: Position } | null;
  up: { move: number; position: Position } | null;
}
