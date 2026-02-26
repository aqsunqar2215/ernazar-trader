import type { Timeframe } from './types.js';

export const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
};

export const timeframeToMs = (timeframe: Timeframe): number => TIMEFRAME_TO_MS[timeframe];

export const bucketTimestamp = (timestamp: number, timeframe: Timeframe): number => {
  const size = timeframeToMs(timeframe);
  return Math.floor(timestamp / size) * size;
};
