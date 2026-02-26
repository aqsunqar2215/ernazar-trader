import { config } from '../core/config.js';
import { timeframeToMs } from '../core/time.js';
import type { Candle, Timeframe, TradingSymbol } from '../core/types.js';
import { StateDb } from '../state/db.js';

type BinanceKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

interface CliOptions {
  symbols: TradingSymbol[];
  timeframes: Timeframe[];
  startTime: number;
  endTime: number;
}

const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const BINANCE_LIMIT = 1000;

const parseArgs = (): CliOptions => {
  const raw = process.argv.slice(2);
  const kv = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (!token || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > -1) {
      kv.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const maybeValue = raw[i + 1];
    if (maybeValue && !maybeValue.startsWith('--')) {
      kv.set(token.slice(2), maybeValue);
      i += 1;
      continue;
    }
    kv.set(token.slice(2), 'true');
  }

  if (kv.has('help') || kv.has('h')) {
    printHelpAndExit(0);
  }

  const symbols = parseSymbols(kv.get('symbols') ?? config.market.symbols.join(','));
  const timeframes = parseTimeframes(kv.get('timeframes') ?? kv.get('tf') ?? '1m');
  const endTime = parseDateMs(kv.get('end')) ?? Date.now();
  const explicitStart = parseDateMs(kv.get('start'));
  const days = parsePositiveInt(kv.get('days'), 365);
  const startTime = explicitStart ?? (endTime - days * 24 * 60 * 60 * 1000);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new Error('invalid time range: start must be less than end');
  }

  return {
    symbols,
    timeframes,
    startTime,
    endTime,
  };
};

const parseSymbols = (value: string): TradingSymbol[] => {
  const items = value
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
  if (items.length === 0) throw new Error('symbols cannot be empty');
  return items;
};

const parseTimeframes = (value: string): Timeframe[] => {
  const allowed: Timeframe[] = ['1m', '5m', '1h'];
  const items = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error('timeframes cannot be empty');
  for (const tf of items) {
    if (!allowed.includes(tf as Timeframe)) {
      throw new Error(`unsupported timeframe: ${tf}`);
    }
  }
  return items as Timeframe[];
};

const parseDateMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) throw new Error(`invalid date: ${value}`);
  return ts;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid positive number: ${value}`);
  return Math.floor(parsed);
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const fetchKlinesWithRetry = async (
  symbol: TradingSymbol,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): Promise<BinanceKlineRow[]> => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const params = new URLSearchParams({
      symbol,
      interval: timeframe,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: String(BINANCE_LIMIT),
    });
    const response = await fetch(`${BINANCE_KLINES_URL}?${params.toString()}`);
    if (response.ok) {
      const payload = (await response.json()) as BinanceKlineRow[];
      return payload;
    }

    if (response.status === 429 || response.status === 418 || response.status >= 500) {
      const delayMs = 600 * attempt;
      await sleep(delayMs);
      continue;
    }

    const body = await response.text();
    throw new Error(`binance klines request failed (${response.status}): ${body}`);
  }

  throw new Error('binance klines request failed after retries');
};

const rowToCandle = (symbol: TradingSymbol, timeframe: Timeframe, row: BinanceKlineRow): Candle => ({
  symbol,
  timeframe,
  openTime: row[0],
  closeTime: row[6],
  open: Number(row[1]),
  high: Number(row[2]),
  low: Number(row[3]),
  close: Number(row[4]),
  volume: Number(row[5]),
  trades: Number(row[8]),
  source: 'exchange',
});

const backfillSymbolTimeframe = async (
  db: StateDb,
  symbol: TradingSymbol,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): Promise<number> => {
  const step = timeframeToMs(timeframe);
  let cursor = Math.floor(startTime / step) * step;
  let total = 0;
  let batch = 0;

  while (cursor < endTime) {
    const rows = await fetchKlinesWithRetry(symbol, timeframe, cursor, endTime);
    if (rows.length === 0) {
      cursor += step * BINANCE_LIMIT;
      continue;
    }

    for (const row of rows) {
      const candle = rowToCandle(symbol, timeframe, row);
      db.upsertCandle(candle);
      total += 1;
    }

    batch += 1;
    if (batch % 10 === 0) {
      const lastOpen = rows[rows.length - 1]?.[0] ?? cursor;
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'backfill progress',
          symbol,
          timeframe,
          batch,
          inserted: total,
          lastOpenTime: new Date(lastOpen).toISOString(),
        }),
      );
    }

    const lastOpenTime = rows[rows.length - 1]?.[0];
    if (!lastOpenTime || lastOpenTime <= cursor) {
      cursor += step;
    } else {
      cursor = lastOpenTime + step;
    }

    await sleep(120);
  }

  return total;
};

const printHelpAndExit = (code: number): never => {
  console.log(`
Usage:
  pnpm backfill --symbols BTCUSDT,ETHUSDT --timeframes 1m --days 365
  pnpm backfill --symbols BTCUSDT --timeframes 1m,5m,1h --start 2024-01-01 --end 2025-01-01

Options:
  --symbols      Comma-separated symbols (default from .env SYMBOLS)
  --timeframes   Comma-separated timeframes: 1m,5m,1h (default: 1m)
  --days         Lookback window in days when --start is not provided (default: 365)
  --start        ISO date/time start (example: 2024-01-01 or 2024-01-01T00:00:00Z)
  --end          ISO date/time end (default: now)
  --help         Show this message
`.trim());
  process.exit(code);
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const db = new StateDb(config.db.path);

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'backfill started',
      dbPath: config.db.path,
      symbols: options.symbols,
      timeframes: options.timeframes,
      start: new Date(options.startTime).toISOString(),
      end: new Date(options.endTime).toISOString(),
    }),
  );

  let grandTotal = 0;
  try {
    for (const symbol of options.symbols) {
      for (const timeframe of options.timeframes) {
        const inserted = await backfillSymbolTimeframe(db, symbol, timeframe, options.startTime, options.endTime);
        grandTotal += inserted;
        console.log(
          JSON.stringify({
            level: 'info',
            message: 'backfill completed for pair',
            symbol,
            timeframe,
            inserted,
          }),
        );
      }
    }
  } finally {
    db.close();
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'backfill finished',
      totalInserted: grandTotal,
    }),
  );
};

main().catch(error => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'backfill failed',
      error: String(error),
    }),
  );
  process.exit(1);
});
