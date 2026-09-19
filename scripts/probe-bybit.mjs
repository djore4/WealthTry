#!/usr/bin/env node
/**
 * Sondagem read-only da Bybit v5.
 *
 * Objetivo: descobrir a FORMA REAL dos dados da tua conta antes de construir
 * qualquer interface por cima de pressupostos.
 *
 * Nao escreve nada. Nao negoceia nada. So le.
 *
 *   node scripts/probe-bybit.mjs            # saida completa (so para os teus olhos)
 *   node scripts/probe-bybit.mjs --redact   # valores mascarados, seguro para partilhar
 *   node scripts/probe-bybit.mjs --redact --out probe-output.json
 *
 * Le as credenciais de .env (ou do ambiente). Ver .env.example.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// --- config -----------------------------------------------------------------

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .env opcional */
  }
}
loadEnv();

const args = new Set(process.argv.slice(2));
const REDACT = args.has('--redact');
const outFlag = process.argv.indexOf('--out');
const OUT_FILE = outFlag !== -1 ? process.argv[outFlag + 1] : null;

const API_KEY = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;
const BASE = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';
const RECV_WINDOW = '5000';

if (!API_KEY || !API_SECRET) {
  console.error('Faltam BYBIT_API_KEY / BYBIT_API_SECRET. Copia .env.example para .env.');
  process.exit(1);
}

const linearSettle = (process.env.BYBIT_LINEAR_SETTLE || 'USDT').split(',').filter(Boolean);
const inverseSettle = (process.env.BYBIT_INVERSE_SETTLE || 'BTC,ETH').split(',').filter(Boolean);

// --- cliente ----------------------------------------------------------------

/** Bybit v5 GET assinado: HMAC(timestamp + apiKey + recvWindow + queryString). */
async function signedGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const ts = Date.now().toString();
  const sign = createHmac('sha256', API_SECRET)
    .update(ts + API_KEY + RECV_WINDOW + qs)
    .digest('hex');

  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': sign,
    },
  });
  const body = await res.json().catch(() => ({ parseError: true }));
  return { httpStatus: res.status, body };
}

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ''}`);
  return { httpStatus: res.status, body: await res.json().catch(() => ({ parseError: true })) };
}

// --- redacao ----------------------------------------------------------------

/**
 * Mascara valores mantendo a estrutura, para poderes colar a saida sem expor
 * saldos nem tamanhos de posicao.
 *
 * Distingue vazio de preenchido de proposito: saber que um campo vem "" ou 0
 * e' precisamente a informacao de que precisamos.
 */
const KEEP = new Set([
  'symbol', 'side', 'category', 'marginMode', 'tradeMode', 'positionStatus',
  'accountType', 'unifiedMarginStatus', 'positionIdx', 'leverage', 'coin',
  'retCode', 'retMsg', 'httpStatus', 'isUta', 'autoAddMargin', 'riskId',
  'createdTime', 'updatedTime', 'settleCoin', 'contractType', 'status',
]);

function redact(value, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (KEEP.has(key)) return value;
  if (typeof value === 'number') return value === 0 ? 0 : '<num>';
  if (typeof value === 'string') {
    if (value === '') return '';
    if (/^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(value)) {
      return Number(value) === 0 ? '0' : '<num-str>';
    }
    return '<str>';
  }
  return value;
}

// --- sondagem ---------------------------------------------------------------

const probes = [
  { name: 'account.info', run: () => signedGet('/v5/account/info') },
  {
    name: 'wallet.UNIFIED',
    run: () => signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
  },
  {
    // Contas pre-UTA guardam o inverse aqui. Um erro nesta sondagem e' informacao, nao falha.
    name: 'wallet.CONTRACT',
    run: () => signedGet('/v5/account/wallet-balance', { accountType: 'CONTRACT' }),
  },
  ...linearSettle.map((settleCoin) => ({
    name: `positions.linear.${settleCoin}`,
    run: () => signedGet('/v5/position/list', { category: 'linear', settleCoin }),
  })),
  ...inverseSettle.map((settleCoin) => ({
    name: `positions.inverse.${settleCoin}`,
    run: () => signedGet('/v5/position/list', { category: 'inverse', settleCoin }),
  })),
  {
    name: 'market.tickers.linear.BTCUSDT',
    run: () => publicGet('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' }),
  },
  {
    name: 'market.tickers.inverse.BTCUSD',
    run: () => publicGet('/v5/market/tickers', { category: 'inverse', symbol: 'BTCUSD' }),
  },
];

// Campos de que o motor de cenarios precisa. Se algum faltar, quero saber ja.
const REQUIRED_POSITION_FIELDS = [
  'symbol', 'side', 'size', 'avgPrice', 'markPrice', 'leverage',
  'liqPrice', 'positionIM', 'unrealisedPnl', 'curRealisedPnl', 'tradeMode',
];

const results = {};
const summary = [];

for (const probe of probes) {
  try {
    const { httpStatus, body } = await probe.run();
    results[probe.name] = { httpStatus, ...(REDACT ? redact(body) : body) };

    const list = body?.result?.list;
    if (probe.name.startsWith('positions.') && Array.isArray(list)) {
      const open = list.filter((p) => Number(p.size) > 0);
      summary.push(`${probe.name}: retCode=${body.retCode} posicoes_abertas=${open.length}`);
      for (const p of open) {
        const missing = REQUIRED_POSITION_FIELDS.filter(
          (f) => p[f] === undefined || p[f] === null || p[f] === '',
        );
        summary.push(
          `    ${p.symbol} (${p.side}, tradeMode=${p.tradeMode === 1 ? 'ISOLATED' : 'CROSS'})` +
            (missing.length ? `  CAMPOS EM FALTA: ${missing.join(', ')}` : '  campos OK'),
        );
      }
    } else {
      summary.push(`${probe.name}: http=${httpStatus} retCode=${body?.retCode} ${body?.retMsg ?? ''}`);
    }
  } catch (err) {
    results[probe.name] = { error: String(err) };
    summary.push(`${probe.name}: ERRO ${err}`);
  }
}

const payload = { probedAt: new Date().toISOString(), redacted: REDACT, results };

if (OUT_FILE) {
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`Escrito em ${OUT_FILE}`);
} else {
  console.log(JSON.stringify(payload, null, 2));
}

console.log('\n================ RESUMO ================');
for (const line of summary) console.log(line);
console.log('========================================');
if (!REDACT) {
  console.log('\nAVISO: saida NAO mascarada. Usa --redact antes de partilhar.');
}
