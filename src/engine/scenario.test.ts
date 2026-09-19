import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveLeverage,
  equityUsd,
  evaluateScenario,
  liqMove,
  liquidationFrontier,
  marginUsd,
  pnlNative,
  pnlUsd,
  projectedFundingUsd,
} from './scenario.ts';
import type { Position } from './types.ts';

const close = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `esperado ~${b}, obtido ${a}`);

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'p',
    symbol: 'BTCUSDT',
    category: 'linear',
    side: 'long',
    size: 10,
    entryPrice: 100,
    markPrice: 100,
    leverage: 1,
    liqPrice: null,
    marginAsset: 'USDT',
    initialMargin: 1000,
    cumFunding: 0,
    fundingRate: 0,
    ...over,
  };
}

/** Linear long 1x: 10 unidades base a 100 = 1000 USD de nocional, margem 1000 USDT. */
const linear1x = position();

/** Inverse long 1x: 1000 USD de nocional a 100 = 10 moedas de margem. */
const inverse1x = position({
  symbol: 'BTCUSD',
  category: 'inverse',
  size: 1000,
  marginAsset: 'BTC',
  initialMargin: 10,
});

describe('pnl linear', () => {
  it('e linear no preco', () => {
    close(pnlNative(linear1x, 110), 100);
    close(pnlNative(linear1x, 90), -100);
    close(pnlNative(linear1x, 200), 1000);
  });

  it('inverte o sinal em short', () => {
    const short = position({ side: 'short' });
    close(pnlNative(short, 90), 100);
    close(pnlNative(short, 110), -100);
  });

  it('em USD e igual ao nativo (USDT ~ USD)', () => {
    close(pnlUsd(linear1x, 110), pnlNative(linear1x, 110));
  });
});

describe('pnl inverse', () => {
  it('e NAO linear na moeda', () => {
    // +100% de preco nao da o dobro de moeda que -50% tira.
    close(pnlNative(inverse1x, 200), 5); // 1000 * (1/100 - 1/200)
    close(pnlNative(inverse1x, 50), -10); // 1000 * (1/100 - 1/50)
  });

  it('em USD iguala uma linear de nocional equivalente', () => {
    // Esta e a correcao importante: nao ha penalizacao no PnL em USD.
    for (const price of [50, 80, 110, 200]) {
      close(pnlUsd(inverse1x, price), pnlUsd(linear1x, price));
    }
  });
});

describe('margem', () => {
  it('linear: margem em USDT nao se move com o preco', () => {
    close(marginUsd(linear1x, 50), 1000);
    close(marginUsd(linear1x, 200), 1000);
  });

  it('inverse: margem desvaloriza com o preco', () => {
    // 10 moedas valem 1000 USD a 100, mas so 500 a 50.
    close(marginUsd(inverse1x, 100), 1000);
    close(marginUsd(inverse1x, 50), 500);
    close(marginUsd(inverse1x, 200), 2000);
  });
});

describe('a assimetria que interessa', () => {
  it('inverse long 1x fica a zero a -50%; linear long 1x ainda tem metade', () => {
    close(equityUsd(inverse1x, 50), 0);
    close(equityUsd(linear1x, 50), 500);
  });

  it('alavancagem efetiva expoe o risco que a nominal esconde', () => {
    // Ambas dizem "1x" na exchange.
    const linear = position({ liqPrice: 0.0001 }); // liquidacao praticamente a zero
    const inverse = position({ ...inverse1x, liqPrice: 50 });

    close(liqMove(inverse)!, -0.5);
    close(effectiveLeverage(inverse)!, 2);
    assert.ok(effectiveLeverage(linear)! < 1.01);
  });
});

describe('liquidationFrontier', () => {
  const positions = [
    position({ symbol: 'A', liqPrice: 60 }), // long, -40%
    position({ symbol: 'B', liqPrice: 82 }), // long, -18%  <- primeira a cair
    position({ symbol: 'C', side: 'short', liqPrice: 130 }), // short, +30%
    position({ symbol: 'D', side: 'short', liqPrice: 115 }), // short, +15%  <- primeira a subir
  ];

  it('encontra a primeira liquidacao em cada direcao', () => {
    const f = liquidationFrontier(positions);
    close(f.down!.move, -0.18);
    assert.equal(f.down!.position.symbol, 'B');
    close(f.up!.move, 0.15);
    assert.equal(f.up!.position.symbol, 'D');
  });

  it('devolve null quando nao ha liquidacao nessa direcao', () => {
    const f = liquidationFrontier([position({ liqPrice: 60 })]);
    assert.equal(f.up, null);
    assert.ok(f.down !== null);
  });
});

describe('evaluateScenario', () => {
  it('aplica o mesmo movimento a todos por omissao', () => {
    const r = evaluateScenario([linear1x, inverse1x], -0.1);
    assert.equal(r.legs.length, 2);
    for (const leg of r.legs) close(leg.move, -0.1);
    close(r.legs[0].price, 90);
  });

  it('aceita override por simbolo', () => {
    const r = evaluateScenario([linear1x, inverse1x], { BTCUSDT: -0.2, BTCUSD: 0.1 });
    close(r.legs[0].move, -0.2);
    close(r.legs[1].move, 0.1);
  });

  it('zera o capital de uma posicao liquidada', () => {
    const p = position({ liqPrice: 90 });
    const r = evaluateScenario([p], -0.2);
    assert.equal(r.legs[0].liquidated, true);
    close(r.legs[0].equityUsd, 0);
    assert.equal(r.totals.liquidatedCount, 1);
    close(r.totals.capitalLossPct, 1);
  });

  it('mede a perda contra o capital de HOJE, nao o do cenario', () => {
    // Inverse a -50%: margem valia 1000 USD hoje, posicao fica a zero.
    const r = evaluateScenario([{ ...inverse1x, liqPrice: 50 }], -0.5);
    close(r.totals.capitalLossPct, 1);
  });
});

describe('funding', () => {
  it('long paga quando a taxa e positiva', () => {
    const p = position({ fundingRate: 0.0001 });
    // 1000 USD nocional * 0.01% * 3 intervalos * 30 dias = -9 USD
    close(projectedFundingUsd(p, 30, 100), -9);
  });

  it('short recebe quando a taxa e positiva', () => {
    const p = position({ side: 'short', fundingRate: 0.0001 });
    close(projectedFundingUsd(p, 30, 100), 9);
  });
});

/**
 * Regressao. A versao anterior somava o pnlUsd de cada perna e ignorava as
 * liquidadas, o que fazia a perda total MELHORAR quando o mercado piorava:
 * a -30% dava -5700 USD e a -40% dava -2400 USD. Absurdo, e do tipo que so
 * aparece quando se executa o codigo.
 */
describe('monotonia da perda', () => {
  const carteira: Position[] = [
    position({ symbol: 'A', liqPrice: 80 }), // liquida a -20%
    position({ symbol: 'B', liqPrice: 65 }), // liquida a -35%
    position({
      symbol: 'C',
      category: 'inverse',
      size: 1000,
      marginAsset: 'BTC',
      initialMargin: 10,
      liqPrice: 50,
    }),
  ];

  it('quanto mais cai o mercado, mais se perde — sem excecoes nas liquidacoes', () => {
    let anterior = Infinity;
    let anteriorEquity = Infinity;

    for (let move = 0.2; move >= -0.6; move -= 0.01) {
      const { totals } = evaluateScenario(carteira, move);
      assert.ok(
        totals.pnlUsd <= anterior + 1e-9,
        `PnL subiu ao descer para ${(move * 100).toFixed(0)}%: ${totals.pnlUsd} > ${anterior}`,
      );
      assert.ok(totals.equityUsd <= anteriorEquity + 1e-9, `equity subiu a ${move}`);
      anterior = totals.pnlUsd;
      anteriorEquity = totals.equityUsd;
    }
  });

  it('a 0% o PnL do cenario iguala o PnL nao realizado', () => {
    const { totals } = evaluateScenario(carteira, 0);
    const naoRealizado = carteira.reduce((s, p) => s + pnlUsd(p, p.markPrice), 0);
    close(totals.pnlUsd, naoRealizado);
  });

  it('perder tudo e -100% do capital, nunca mais do que isso', () => {
    const { totals } = evaluateScenario(carteira, -0.9);
    assert.equal(totals.liquidatedCount, 3);
    close(totals.capitalLossPct, 1);
    close(totals.pnlUsd, -totals.baseCapitalUsd);
  });
});
