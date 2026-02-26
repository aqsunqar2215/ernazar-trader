import type { Candle, Signal } from '../core/types.js';
import type { Strategy } from './strategy.js';

export class MomentumMeanReversionStrategy implements Strategy {
  private readonly closes = new Map<string, number[]>();

  onCandle(candle: Candle): Signal {
    const key = `${candle.symbol}:${candle.timeframe}`;
    const series = this.closes.get(key) ?? [];
    series.push(candle.close);
    if (series.length > 128) series.splice(0, series.length - 128);
    this.closes.set(key, series);

    if (series.length < 20) {
      return {
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        action: 'hold',
        strength: 0,
        reason: 'not enough history',
        timestamp: Date.now(),
      };
    }

    const short = average(series.slice(-5));
    const long = average(series.slice(-20));
    const ratio = (short - long) / long;

    let action: Signal['action'] = 'hold';
    let reason = 'flat';
    if (ratio > 0.0025) {
      action = 'buy';
      reason = 'momentum breakout';
    } else if (ratio < -0.0025) {
      action = 'sell';
      reason = 'mean reversion / downside momentum';
    }

    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      action,
      strength: Math.min(1, Math.abs(ratio) * 150),
      reason,
      timestamp: Date.now(),
    };
  }
}

const average = (items: number[]): number => items.reduce((sum, item) => sum + item, 0) / items.length;
