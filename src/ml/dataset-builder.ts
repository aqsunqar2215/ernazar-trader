import type { Candle, Fill } from '../core/types.js';
import { extractFeatures, featureLookback } from './features.js';

export interface TrainingSample {
  timestamp: number;
  symbol: string;
  features: number[];
  label: number;
}

export class DatasetBuilder {
  build(candles: Candle[], fills: Fill[], horizonBars: number = 3): TrainingSample[] {
    const filtered = candles.filter(candle => candle.source !== 'gap_fill');
    const grouped = groupBySeries(filtered);
    const samples: TrainingSample[] = [];

    for (const [seriesKey, series] of grouped.entries()) {
      if (series.length < featureLookback + 40) continue;
      const symbolFills = fills.filter(fill => fill.symbol === (series[0]?.symbol ?? 'BTCUSDT'));
      for (let i = featureLookback - 1; i < series.length - horizonBars; i += 1) {
        const window = series.slice(i - (featureLookback - 1), i + 1);
        const current = series[i];
        const future = series[i + horizonBars];
        const features = extractFeatures(window, symbolFills, {
          position: 0,
          positionAge: 0,
          lastTurnoverAge: 0,
        });
        const ret = (future.close - current.close) / current.close;
        const label = ret > 0.001 ? 1 : ret < -0.001 ? -1 : 0;
        samples.push({
          timestamp: current.closeTime,
          symbol: current.symbol,
          features,
          label,
        });
      }
    }

    return samples;
  }
}

const groupBySeries = (candles: Candle[]): Map<string, Candle[]> => {
  const map = new Map<string, Candle[]>();
  for (const candle of candles) {
    const key = `${candle.symbol}:${candle.timeframe}`;
    const list = map.get(key) ?? [];
    list.push(candle);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.openTime - b.openTime);
  }
  return map;
};
