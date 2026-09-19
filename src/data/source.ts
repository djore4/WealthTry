/**
 * Fonte de dados do portefolio.
 *
 * Esta abstracao existe por uma razao pratica: permite construir e verificar a
 * aplicacao inteira sem tocar numa conta real. A fonte de fixtures e a fonte
 * Bybit passam pelo MESMO normalizador, por isso o que e' testado com dados
 * sinteticos e' exatamente o caminho que corre em producao.
 */

import type { Position } from '../engine/types.ts';
import type { Diagnostic } from '../bybit/normalize.ts';

export interface PortfolioSnapshot {
  fetchedAt: string;
  source: string;
  positions: Position[];
  /**
   * O que a camada de dados nao conseguiu mapear com confianca.
   * Isto e' para ser MOSTRADO ao utilizador, nao enterrado num log.
   */
  diagnostics: Diagnostic[];
}

export interface DataSource {
  readonly name: string;
  fetchPortfolio(): Promise<PortfolioSnapshot>;
}
