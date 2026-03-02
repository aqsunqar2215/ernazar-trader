import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { bucketTimestamp, timeframeToMs } from '../core/time.js';
import type { Candle, Timeframe, TradeTick, TradingSymbol } from '../core/types.js';
import { CandlesCache } from './candles-cache.js';
import { fillGaps, isTimestampValid } from './data-quality.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';

interface FeedOptions {
  mode: 'mock' | 'binance';
  symbols: TradingSymbol[];
  timeframes: Timeframe[];
}

interface MockRegime {
  drift: number;
  vol: number;
  meanRevert: number;
  cycleAmp: number;
  remaining: number;
}

interface BinanceKlineMessage {
  data: {
    s: string;
    E: number;
    k: {
      i: string;
      t: number;
      T: number;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
      n: number;
    };
  };
}

interface BinanceTradeMessage {
  data: {
    s: string;
    T: number;
    p: string;
    q: string;
    m: boolean;
    t: number;
  };
}

export class MarketDataFeed extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private mockTimer?: NodeJS.Timeout;
  private running: boolean = false;
  private mockClock: number = 0;
  private readonly lastPrice = new Map<TradingSymbol, number>();
  private lastEventTimestamp: number = 0;
  private readonly logger: Logger;
  private readonly mockRegimes = new Map<TradingSymbol, MockRegime>();
  private readonly mockVol = new Map<TradingSymbol, number>();
  private readonly mockPrevReturn = new Map<TradingSymbol, number>();

  constructor(
    private readonly db: StateDb,
    private readonly cache: CandlesCache,
    logger: Logger,
    private readonly options: FeedOptions,
  ) {
    super();
    this.logger = logger.child('market-feed');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.options.mode === 'binance') {
      this.startBinance();
      return;
    }
    this.startMock();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.mockTimer) clearInterval(this.mockTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  getLastPrice(symbol: TradingSymbol): number | undefined {
    return this.lastPrice.get(symbol);
  }

  getLastEventTimestamp(): number {
    return this.lastEventTimestamp;
  }

  private startMock(): void {
    const now = Date.now();
    const offsetMinutesRaw = Number(process.env.MOCK_CLOCK_OFFSET_MINUTES ?? '0');
    const offsetMinutes = Number.isFinite(offsetMinutesRaw) ? Math.max(0, offsetMinutesRaw) : 0;
    const offsetMs = offsetMinutes * 60_000;
    this.mockClock = bucketTimestamp(now - offsetMs, '1m');

    for (const symbol of this.options.symbols) {
      this.lastPrice.set(symbol, symbol.startsWith('ETH') ? 3_500 : 65_000);
      this.seedMockHistory(symbol, 420);
    }

    this.mockTimer = setInterval(() => this.generateMockTick(), 1_000);
    this.logger.info('mock market feed started', { symbols: this.options.symbols.join(',') });
  }

  private seedMockHistory(symbol: TradingSymbol, bars: number): void {
    let price = this.lastPrice.get(symbol) ?? 60_000;
    let cursor = this.mockClock - bars * timeframeToMs('1m');

    for (let i = 0; i < bars; i += 1) {
      const next = this.makeMockCandle(symbol, cursor, price, '1m');
      price = next.close;
      this.ingestCandle(next);
      cursor += timeframeToMs('1m');
    }

    this.lastPrice.set(symbol, price);
  }

  private generateMockTick(): void {
    this.mockClock += timeframeToMs('1m');

    for (const symbol of this.options.symbols) {
      const price = this.lastPrice.get(symbol) ?? 50_000;
      const candle1m = this.makeMockCandle(symbol, this.mockClock, price, '1m');
      this.lastPrice.set(symbol, candle1m.close);
      this.ingestCandle(candle1m);

      const trade: TradeTick = {
        symbol,
        timestamp: candle1m.closeTime,
        price: candle1m.close,
        quantity: Math.max(0.001, Math.random() * 0.25),
        side: Math.random() > 0.5 ? 'buy' : 'sell',
        source: 'mock',
      };
      this.ingestTrade(trade);

      if (this.mockClock % timeframeToMs('5m') === 0) {
        this.rebuildAggregate(symbol, '5m', 5);
      }
      if (this.mockClock % timeframeToMs('1h') === 0) {
        this.rebuildAggregate(symbol, '1h', 60);
      }
    }
  }

  private rebuildAggregate(symbol: TradingSymbol, timeframe: Timeframe, points: number): void {
    const source = this.cache.get(symbol, '1m', points);
    if (source.length < points) return;
    const first = source[0];
    const last = source[source.length - 1];
    if (!first || !last) return;
    const openTime = bucketTimestamp(first.openTime, timeframe);
    const closeTime = openTime + timeframeToMs(timeframe) - 1;
    const candle: Candle = {
      symbol,
      timeframe,
      openTime,
      closeTime,
      open: first.open,
      high: Math.max(...source.map(item => item.high)),
      low: Math.min(...source.map(item => item.low)),
      close: last.close,
      volume: source.reduce((sum, item) => sum + item.volume, 0),
      trades: source.reduce((sum, item) => sum + item.trades, 0),
      source: 'mock',
    };
    this.ingestCandle(candle);
  }

  private mockCyclePhase = new Map<TradingSymbol, number>();
  private mockRegimeStep = new Map<TradingSymbol, number>();

  private makeMockCandle(
    symbol: TradingSymbol,
    openTime: number,
    price: number,
    timeframe: Timeframe,
  ): Candle {
    let phase = this.mockCyclePhase.get(symbol) ?? 0;
    phase += (2 * Math.PI) / 90;
    this.mockCyclePhase.set(symbol, phase);

    const regime = this.nextMockRegime(symbol, price);
    const prevVol = this.mockVol.get(symbol) ?? regime.vol;
    const vol = Math.max(0.00005, prevVol * 0.85 + regime.vol * 0.15 + randn() * regime.vol * 0.05);
    this.mockVol.set(symbol, vol);

    const prevRet = this.mockPrevReturn.get(symbol) ?? 0;
    const cycle = Math.cos(phase) * regime.cycleAmp;
    let ret = regime.drift + cycle + randn() * vol - regime.meanRevert * prevRet;
    if (Math.random() < 0.012) {
      ret += randn() * vol * 5.5;
    }
    this.mockPrevReturn.set(symbol, ret);

    const close = Math.max(price * 0.2, price * (1 + ret));
    const range = Math.abs(ret) + vol * randomBetween(0.4, 1.2);
    const wick = Math.max(price * 0.0004, price * range);
    const high = Math.max(price, close) + wick;
    const low = Math.min(price, close) - wick;
    const step = timeframeToMs(timeframe);

    const volBase = symbol.startsWith('ETH') ? 180 : 70;
    const activityBoost = 1 + Math.min(3, Math.abs(ret) / 0.002 + vol / 0.002);

    return {
      symbol,
      timeframe,
      openTime,
      closeTime: openTime + step - 1,
      open: price,
      high,
      low,
      close,
      volume: (Math.random() * 0.6 + 0.4) * volBase * activityBoost,
      trades: Math.max(5, Math.floor((Math.random() * 0.6 + 0.4) * 120 * activityBoost)),
      source: 'mock',
    };
  }

  private nextMockRegime(symbol: TradingSymbol, price: number): MockRegime {
    const step = (this.mockRegimeStep.get(symbol) ?? 0) + 1;
    this.mockRegimeStep.set(symbol, step);
    const current = this.mockRegimes.get(symbol);
    if (current && current.remaining > 0) {
      current.remaining -= 1;
      return current;
    }

    const baseVol = symbol.startsWith('ETH') ? 0.0018 : 0.0012;
    const regime: MockRegime = {
      drift: randomBetween(-0.0004, 0.0006),
      vol: randomBetween(baseVol * 0.6, baseVol * 2.5),
      meanRevert: randomBetween(0, 0.35),
      cycleAmp: randomBetween(0.00025, 0.0012),
      remaining: Math.floor(randomBetween(120, 520)),
    };
    this.mockRegimes.set(symbol, regime);
    this.logger.debug?.('mock regime rotated', {
      symbol,
      drift: regime.drift,
      vol: regime.vol,
      meanRevert: regime.meanRevert,
      cycleAmp: regime.cycleAmp,
      remaining: regime.remaining,
      anchor: price,
    });
    return regime;
  }

  private startBinance(): void {
    const streams: string[] = [];
    for (const symbol of this.options.symbols) {
      const normalized = symbol.toLowerCase();
      streams.push(`${normalized}@trade`);
      for (const timeframe of this.options.timeframes) {
        streams.push(`${normalized}@kline_${timeframe}`);
      }
    }

    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.logger.info('binance websocket connected');
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as BinanceKlineMessage | BinanceTradeMessage;
        this.handleBinanceMessage(payload);
      } catch (error) {
        this.logger.warn('failed to parse binance message', { error: String(error) });
      }
    });

    this.ws.on('close', () => {
      this.logger.warn('binance websocket closed');
      if (!this.running) return;
      this.reconnectTimer = setTimeout(() => this.startBinance(), 5_000);
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('binance websocket error', { error: String(error) });
    });
  }

  private handleBinanceMessage(payload: BinanceKlineMessage | BinanceTradeMessage): void {
    if ('k' in payload.data) {
      const k = payload.data.k;
      const timeframe = k.i as Timeframe;
      if (!this.options.timeframes.includes(timeframe)) return;
      const candle: Candle = {
        symbol: payload.data.s,
        timeframe,
        openTime: k.t,
        closeTime: k.T,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        trades: Number(k.n),
        source: 'exchange',
      };
      this.ingestCandle(candle);
      return;
    }

    const t = payload.data;
    const trade: TradeTick = {
      symbol: t.s,
      timestamp: t.T,
      price: Number(t.p),
      quantity: Number(t.q),
      side: t.m ? 'sell' : 'buy',
      tradeId: String(t.t),
      source: 'exchange',
    };
    this.lastPrice.set(trade.symbol, trade.price);
    this.ingestTrade(trade);
  }

  private ingestTrade(trade: TradeTick): void {
    if (!isTimestampValid(trade.timestamp)) return;
    this.lastEventTimestamp = Date.now();
    this.db.insertTrade(trade);
    this.emit('trade', trade);
  }

  private ingestCandle(candle: Candle): void {
    if (!isTimestampValid(candle.openTime)) return;
    this.lastPrice.set(candle.symbol, candle.close);
    this.lastEventTimestamp = Date.now();

    const latest = this.cache.get(candle.symbol, candle.timeframe, 1);
    const previous = latest[0];
    const normalized = previous ? fillGaps([previous, candle], candle.timeframe) : [candle];
    const toStore = normalized.slice(previous ? 1 : 0);

    for (const item of toStore) {
      this.cache.put(item);
      this.db.upsertCandle(item);
      this.emit('candle', item);
    }
  }
}

const randn = (): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const randomBetween = (min: number, max: number): number => {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
};
