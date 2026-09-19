/**
 * Fonte de dados real. Le a Bybit e devolve o mesmo formato que a fonte de
 * fixtures, incluindo os diagnosticos.
 *
 * Os diagnosticos substituem o script de sondagem manual: na primeira ligacao,
 * a aplicacao diz o que conseguiu mapear e o que teve de assumir.
 */

import { BybitClient, type BybitConfig } from '../bybit/client.ts';
import { applyFunding, normalizePositions, type Diagnostic } from '../bybit/normalize.ts';
import type { Position } from '../engine/types.ts';
import type { DataSource, PortfolioSnapshot } from './source.ts';

export interface BybitSourceConfig extends BybitConfig {
  /** Moedas de liquidacao a sondar em linear. Normalmente ['USDT']. */
  linearSettleCoins?: string[];
  /** Moedas de liquidacao a sondar em inverse. Uma por moeda base. */
  inverseSettleCoins?: string[];
}

export class BybitSource implements DataSource {
  readonly name = 'bybit';
  #client: BybitClient;
  #linear: string[];
  #inverse: string[];

  constructor(config: BybitSourceConfig) {
    this.#client = new BybitClient(config);
    this.#linear = config.linearSettleCoins ?? ['USDT'];
    this.#inverse = config.inverseSettleCoins ?? ['BTC', 'ETH'];
  }

  async fetchPortfolio(): Promise<PortfolioSnapshot> {
    const positions: Position[] = [];
    const diagnostics: Diagnostic[] = [];

    const groups = [
      ...this.#linear.map((settleCoin) => ({ category: 'linear' as const, settleCoin })),
      ...this.#inverse.map((settleCoin) => ({ category: 'inverse' as const, settleCoin })),
    ];

    for (const { category, settleCoin } of groups) {
      let raws;
      try {
        raws = await this.#client.positions(category, settleCoin);
      } catch (err) {
        // Uma moeda de liquidacao sem posicoes pode devolver erro. Nao e' fatal,
        // mas tambem nao e' para ignorar em silencio.
        diagnostics.push({
          severity: 'warning',
          symbol: `${category}/${settleCoin}`,
          code: 'sondagem_falhou',
          message: `Nao foi possivel ler posicoes: ${(err as Error).message}`,
        });
        continue;
      }
      const result = normalizePositions(raws, category, settleCoin);
      positions.push(...result.positions);
      diagnostics.push(...result.diagnostics);
    }

    const funded = await this.#withFunding(positions, diagnostics);

    return {
      fetchedAt: new Date().toISOString(),
      source: this.name,
      positions: funded,
      diagnostics,
    };
  }

  /** Funding acumulado, a partir do registo de transacoes desde a posicao mais antiga. */
  async #withFunding(positions: Position[], diagnostics: Diagnostic[]): Promise<Position[]> {
    if (positions.length === 0) return positions;

    let result = positions;
    for (const category of ['linear', 'inverse'] as const) {
      const slice = result.filter((p) => p.category === category);
      if (slice.length === 0) continue;

      // 30 dias e' um compromisso: janela suficiente para posicoes recentes sem
      // paginar meses de registos. Posicoes mais antigas ficam subestimadas, e
      // e' por isso que o normalizador avisa quando nao encontra registos.
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      try {
        const txs = await this.#client.fundingSince(category, since);
        const applied = applyFunding(slice, txs);
        diagnostics.push(...applied.diagnostics);
        const bySymbol = new Map(applied.positions.map((p) => [p.id, p]));
        result = result.map((p) => bySymbol.get(p.id) ?? p);
      } catch (err) {
        diagnostics.push({
          severity: 'warning',
          symbol: category,
          code: 'funding_falhou',
          message: `Registo de funding indisponivel: ${(err as Error).message}`,
        });
      }
    }
    return result;
  }
}
