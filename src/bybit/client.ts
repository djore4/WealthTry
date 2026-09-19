/**
 * Cliente Bybit v5. Camada fina e isolada: se a API mudar, muda este ficheiro.
 *
 * ESTRITAMENTE READ-ONLY. Nao existe aqui nenhum metodo que crie, altere ou
 * cancele ordens, e nao deve passar a existir. Se um dia for preciso negociar,
 * isso vive noutro modulo com outra chave.
 */

import { createHmac } from 'node:crypto';

export interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  recvWindow?: number;
  /** Injetavel para testes. */
  fetchImpl?: typeof fetch;
}

export interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export class BybitError extends Error {
  readonly retCode: number;
  readonly path: string;

  constructor(message: string, retCode: number, path: string) {
    super(message);
    this.name = 'BybitError';
    this.retCode = retCode;
    this.path = path;
  }
}

/** Posicao crua, tal como a v5 a devolve. Strings numericas por todo o lado. */
export interface RawPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | '';
  size: string;
  avgPrice: string;
  markPrice: string;
  leverage: string;
  liqPrice: string;
  positionValue: string;
  positionIM: string;
  positionMM: string;
  unrealisedPnl: string;
  curRealisedPnl: string;
  /** 0 = cruzada, 1 = isolada. */
  tradeMode: number;
  positionIdx: number;
  createdTime: string;
  updatedTime: string;
  [extra: string]: unknown;
}

/** Entrada do registo de transacoes. O funding chega por aqui, nao pela posicao. */
export interface RawTransaction {
  symbol: string;
  category: string;
  currency: string;
  /** 'SETTLEMENT' = funding. 'TRADE', 'TRANSFER_IN', ... */
  type: string;
  funding: string;
  change: string;
  cashFlow: string;
  transactionTime: string;
  [extra: string]: unknown;
}

const MAINNET = 'https://api.bybit.com';
const TESTNET = 'https://api-testnet.bybit.com';

export class BybitClient {
  #key: string;
  #secret: string;
  #base: string;
  #recvWindow: string;
  #fetch: typeof fetch;

  constructor(config: BybitConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('BybitClient exige apiKey e apiSecret');
    }
    this.#key = config.apiKey;
    this.#secret = config.apiSecret;
    this.#base = config.testnet ? TESTNET : MAINNET;
    this.#recvWindow = String(config.recvWindow ?? 5000);
    this.#fetch = config.fetchImpl ?? fetch;
  }

  /** GET assinado: HMAC-SHA256 de (timestamp + apiKey + recvWindow + queryString). */
  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const ts = Date.now().toString();
    const sign = createHmac('sha256', this.#secret)
      .update(ts + this.#key + this.#recvWindow + qs)
      .digest('hex');

    const res = await this.#fetch(`${this.#base}${path}${qs ? `?${qs}` : ''}`, {
      headers: {
        'X-BAPI-API-KEY': this.#key,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': this.#recvWindow,
        'X-BAPI-SIGN': sign,
      },
    });

    const body = (await res.json()) as BybitResponse<T>;
    if (body.retCode !== 0) {
      throw new BybitError(body.retMsg || `retCode ${body.retCode}`, body.retCode, path);
    }
    return body.result;
  }

  /**
   * Posicoes abertas de uma categoria.
   *
   * A Bybit exige `settleCoin` ou `symbol`. Para inverse, cada moeda base e' uma
   * moeda de liquidacao distinta (BTCUSD liquida em BTC), por isso e' preciso
   * sondar uma a uma.
   */
  async positions(
    category: 'linear' | 'inverse',
    settleCoin: string,
  ): Promise<RawPosition[]> {
    const result = await this.#get<{ list: RawPosition[] }>('/v5/position/list', {
      category,
      settleCoin,
      limit: '200',
    });
    // A Bybit devolve posicoes a zero para simbolos ja fechados. Nao interessam.
    return (result.list ?? []).filter((p) => Number(p.size) > 0);
  }

  /**
   * Registo de transacoes, que e' onde o funding realmente vive.
   *
   * Descoberta que mudou o desenho: o objeto de posicao NAO traz o funding
   * acumulado. `curRealisedPnl` e' PnL realizado com taxas de negociacao, nao
   * funding. Para o indicador "funding pago/recebido desde a abertura" e'
   * obrigatorio agregar os registos de tipo SETTLEMENT desde `createdTime`.
   */
  async fundingSince(
    category: 'linear' | 'inverse',
    startTimeMs: number,
  ): Promise<RawTransaction[]> {
    const out: RawTransaction[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.#get<{ list: RawTransaction[]; nextPageCursor?: string }>(
        '/v5/account/transaction-log',
        {
          category,
          type: 'SETTLEMENT',
          startTime: String(startTimeMs),
          limit: '100',
          ...(cursor ? { cursor } : {}),
        },
      );
      out.push(...(result.list ?? []));
      cursor = result.nextPageCursor || undefined;
    } while (cursor && out.length < 1000);

    return out;
  }

  /** Estado da conta — serve para detetar UTA vs pre-UTA. */
  async accountInfo(): Promise<Record<string, unknown>> {
    return this.#get('/v5/account/info');
  }

  async walletBalance(accountType: 'UNIFIED' | 'CONTRACT' = 'UNIFIED') {
    return this.#get<{ list: Record<string, unknown>[] }>('/v5/account/wallet-balance', {
      accountType,
    });
  }
}
