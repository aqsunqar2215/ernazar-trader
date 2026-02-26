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
    this.mockClock = bucketTimestamp(now, '1m');

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

  private makeMockCandle(
    symbol: TradingSymbol,
    openTime: number,
    price: number,
    timeframe: Timeframe,
  ): Candle {
    // 60-bar sine wave (60 minutes)
    let phase = this.mockCyclePhase.get(symbol) ?? 0;
    phase += (2 * Math.PI) / 60;
    this.mockCyclePhase.set(symbol, phase);

    // Very strong signal: 100 bps per bar at peak
    const cycleDrift = Math.cos(phase) * 0.0100;

    // Zero noise
    const deltaPct = cycleDrift;

    const close = Math.max(price * 0.5, price * (1 + deltaPct));
    const wick = Math.abs(deltaPct) * price * 0.8 + price * 0.0003;
    const high = Math.max(price, close) + wick;
    const low = Math.min(price, close) - wick;
    const step = timeframeToMs(timeframe);

    const volBase = symbol.startsWith('ETH') ? 220 : 80;

    return {
      symbol,
      timeframe,
      openTime,
      closeTime: openTime + step - 1,
      open: price,
      high,
      low,
      close,
      volume: Math.random() * volBase + volBase * 0.5,
      trades: Math.floor(Math.random() * 140) + 10,
      source: 'mock',
    };
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
