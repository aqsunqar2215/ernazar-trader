import { timeframeToMs } from '../core/time.js';
import type { Candle, Timeframe } from '../core/types.js';

export const isTimestampValid = (
  timestamp: number,
  now: number = Date.now(),
  maxFutureMs: number = 60_000,
  maxPastMs: number = 10 * 24 * 60 * 60 * 1_000,
): boolean => {
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp > now + maxFutureMs) return false;
  if (timestamp < now - maxPastMs) return false;
  return true;
};

export const fillGaps = (candles: Candle[], timeframe: Timeframe): Candle[] => {
  if (candles.length <= 1) return candles;

  const step = timeframeToMs(timeframe);
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const first = sorted[0];
  if (!first) return [];
  const result: Candle[] = [first];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (!current) continue;
    let previous = result[result.length - 1];
    if (!previous) continue;

    while (current.openTime - previous.openTime > step) {
      const openTime = previous.openTime + step;
      const closeTime = openTime + step - 1;
      const synthetic: Candle = {
        symbol: previous.symbol,
        timeframe: previous.timeframe,
        openTime,
        closeTime,
        open: previous.close,
        high: previous.close,
        low: previous.close,
        close: previous.close,
        volume: 0,
        trades: 0,
        source: 'gap_fill',
      };
      result.push(synthetic);
      previous = synthetic;
    }

    result.push(current);
  }

  return result;
};
