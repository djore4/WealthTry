import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFunding,
  baseCoinOf,
  deriveLiqPrice,
  normalizePosition,
  normalizePositions,
} from './normalize.ts';
import type { Diagnostic } from './normalize.ts';
import type { RawPosition, RawTransaction } from './client.ts';
import type { Position } from '../engine/types.ts';

const close = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `esperado ~${b}, obtido ${a}`);

function raw(over: Partial<RawPosition> = {}): RawPosition {
  return {
    symbol: 'BTCUSDT',
    side: 'Buy',
    size: '10',
    avgPrice: '100',
    markPrice: '100',
    leverage: '1',
    liqPrice: '50',
    positionValue: '1000',
    positionIM: '1000',
    positionMM: '5',
    unrealisedPnl: '0',
    curRealisedPnl: '0',
    tradeMode: 1,
    positionIdx: 0,
    createdTime: '1700000000000',
    updatedTime: '1700000000000',
    ...over,
  };
}

const codes = (d: Diagnostic[]) => d.map((x) => x.code);

describe('baseCoinOf', () => {
  it('extrai a moeda base de simbolos inverse', () => {
    assert.equal(baseCoinOf('BTCUSD'), 'BTC');
    assert.equal(baseCoinOf('ETHUSD'), 'ETH');
  });

  it('prefere o settleCoin quando fornecido', () => {
    assert.equal(baseCoinOf('QUALQUERCOISA', 'SOL'), 'SOL');
  });
});

describe('normalizePosition', () => {
  it('mapeia Buy/Sell para long/short', () => {
    const d: Diagnostic[] = [];
    assert.equal(normalizePosition(raw(), 'linear', 'USDT', d)!.side, 'long');
    assert.equal(normalizePosition(raw({ side: 'Sell' }), 'linear', 'USDT', d)!.side, 'short');
  });

  it('rejeita posicoes inutilizaveis em vez de inventar numeros', () => {
    for (const [over, code] of [
      [{ side: '' as const }, 'side_desconhecido'],
      [{ size: '0' }, 'size_invalido'],
      [{ avgPrice: '' }, 'entrada_invalida'],
      [{ markPrice: '0' }, 'mark_invalido'],
    ] as const) {
      const d: Diagnostic[] = [];
      assert.equal(normalizePosition(raw(over), 'linear', 'USDT', d), null);
      assert.deepEqual(codes(d), [code]);
    }
  });

  it('avisa em margem cruzada, porque a liquidacao passa a ser da conta', () => {
    const d: Diagnostic[] = [];
    normalizePosition(raw({ tradeMode: 0 }), 'linear', 'USDT', d);
    assert.ok(codes(d).includes('margem_cruzada'));
  });

  it('prefere sempre o liqPrice da exchange', () => {
    const d: Diagnostic[] = [];
    const p = normalizePosition(raw({ liqPrice: '42' }), 'linear', 'USDT', d)!;
    close(p.liqPrice!, 42);
    assert.ok(!codes(d).includes('liq_derivada'));
  });

  it('calcula o liqPrice quando falta, e diz que o calculou', () => {
    const d: Diagnostic[] = [];
    // 2x: IM 500 sobre nocional 1000 -> liquidacao a -50%
    const p = normalizePosition(
      raw({ liqPrice: '', positionIM: '500', leverage: '2', positionMM: '0' }),
      'linear',
      'USDT',
      d,
    )!;
    close(p.liqPrice!, 50, 0.5);
    assert.ok(codes(d).includes('liq_derivada'));
    assert.ok(codes(d).includes('mm_assumida'));
  });

  it('deriva a taxa de manutencao de positionMM/positionValue', () => {
    const d: Diagnostic[] = [];
    normalizePosition(raw({ positionMM: '5', positionValue: '1000' }), 'linear', 'USDT', d);
    assert.ok(!codes(d).includes('mm_assumida'), 'nao devia assumir quando tem o valor real');
  });

  it('atribui a moeda de margem correta a cada categoria', () => {
    const d: Diagnostic[] = [];
    assert.equal(normalizePosition(raw(), 'linear', 'USDT', d)!.marginAsset, 'USDT');
    const inv = normalizePosition(raw({ symbol: 'BTCUSD' }), 'inverse', 'BTC', d)!;
    assert.equal(inv.marginAsset, 'BTC');
  });
});

/**
 * A tabela que justifica o projeto. Nocional de 1000 USD a um preco de 100,
 * sem margem de manutencao, para os numeros ficarem limpos.
 *
 * Inverse LONG e' sempre pior que linear. Inverse SHORT e' sempre melhor.
 * Nenhuma destas assimetrias aparece na alavancagem que a exchange mostra.
 */
describe('fronteira de liquidacao: linear vs inverse', () => {
  const linear = (side: 'long' | 'short', lev: number) =>
    deriveLiqPrice({
      category: 'linear',
      side,
      size: 10, // 10 unidades base
      entryPrice: 100,
      initialMargin: 1000 / lev, // em USDT
      mmRate: 0,
    });

  const inverse = (side: 'long' | 'short', lev: number) =>
    deriveLiqPrice({
      category: 'inverse',
      side,
      size: 1000, // 1000 USD de nocional
      entryPrice: 100,
      initialMargin: 10 / lev, // em moeda base
      mmRate: 0,
    });

  it('1x long: linear nunca liquida, inverse liquida a -50%', () => {
    assert.equal(linear('long', 1), null); // exigiria preco zero
    close(inverse('long', 1)!, 50);
  });

  it('1x short: linear liquida a +100%, inverse nunca liquida', () => {
    close(linear('short', 1)!, 200);
    assert.equal(inverse('short', 1), null);
  });

  it('2x long: linear a -50%, inverse a -33%', () => {
    close(linear('long', 2)!, 50);
    close(inverse('long', 2)!, 200 / 3);
  });

  it('2x short: linear a +50%, inverse a +100%', () => {
    close(linear('short', 2)!, 150);
    close(inverse('short', 2)!, 200);
  });

  it('a margem de manutencao aproxima a liquidacao', () => {
    const semMM = linear('long', 2)!;
    const comMM = deriveLiqPrice({
      category: 'linear',
      side: 'long',
      size: 10,
      entryPrice: 100,
      initialMargin: 500,
      mmRate: 0.005,
    })!;
    assert.ok(comMM > semMM, 'com manutencao, o long liquida mais cedo (preco mais alto)');
  });
});

describe('normalizePositions', () => {
  it('mantem as boas e acumula diagnosticos das ms', () => {
    const { positions, diagnostics } = normalizePositions(
      [raw(), raw({ symbol: 'ETHUSDT', side: '' as const })],
      'linear',
      'USDT',
    );
    assert.equal(positions.length, 1);
    assert.equal(positions[0].symbol, 'BTCUSDT');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].symbol, 'ETHUSDT');
  });
});

describe('applyFunding', () => {
  const position = (symbol: string): Position => ({
    id: symbol,
    symbol,
    category: 'linear',
    side: 'long',
    size: 1,
    entryPrice: 100,
    markPrice: 100,
    leverage: 1,
    liqPrice: null,
    marginAsset: 'USDT',
    initialMargin: 100,
    cumFunding: 0,
    fundingRate: 0,
  });

  const tx = (symbol: string, funding: string, type = 'SETTLEMENT'): RawTransaction => ({
    symbol,
    category: 'linear',
    currency: 'USDT',
    type,
    funding,
    change: funding,
    cashFlow: '0',
    transactionTime: '1700000000000',
  });

  it('soma os registos SETTLEMENT por simbolo', () => {
    const { positions } = applyFunding(
      [position('BTCUSDT')],
      [tx('BTCUSDT', '-1.5'), tx('BTCUSDT', '-2.25'), tx('BTCUSDT', '0.75')],
    );
    close(positions[0].cumFunding, -3);
  });

  it('ignora registos que nao sao funding', () => {
    const { positions } = applyFunding(
      [position('BTCUSDT')],
      [tx('BTCUSDT', '-1'), tx('BTCUSDT', '-99', 'TRADE')],
    );
    close(positions[0].cumFunding, -1);
  });

  it('avisa quando nao encontra funding, em vez de mostrar zero em silencio', () => {
    const { positions, diagnostics } = applyFunding([position('BTCUSDT')], []);
    close(positions[0].cumFunding, 0);
    assert.deepEqual(codes(diagnostics), ['sem_funding']);
  });
});
