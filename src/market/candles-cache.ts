import type { Candle, Timeframe, TradingSymbol } from '../core/types.js';

const buildKey = (symbol: TradingSymbol, timeframe: Timeframe): string => `${symbol}:${timeframe}`;

export class CandlesCache {
  private readonly store = new Map<string, Candle[]>();

  constructor(private readonly maxPerSeries: number) {}

  put(candle: Candle): void {
    const key = buildKey(candle.symbol, candle.timeframe);
    const series = this.store.get(key) ?? [];

    const idx = series.findIndex(item => item.openTime === candle.openTime);
    if (idx >= 0) {
      series[idx] = candle;
    } else {
      series.push(candle);
      series.sort((a, b) => a.openTime - b.openTime);
    }

    if (series.length > this.maxPerSeries) {
      series.splice(0, series.length - this.maxPerSeries);
    }

    this.store.set(key, series);
  }

  get(symbol: TradingSymbol, timeframe: Timeframe, limit: number): Candle[] {
    const key = buildKey(symbol, timeframe);
    const series = this.store.get(key) ?? [];
    if (series.length <= limit) return [...series];
    return series.slice(series.length - limit);
  }
}
