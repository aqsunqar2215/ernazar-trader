import type { Candle, Signal } from '../core/types.js';
import type { Strategy } from './strategy.js';
import type { TrainedModel } from '../ml/train.js';
import { extractFeatures, featureLookback } from '../ml/features.js';

export class SupervisedLinearStrategy implements Strategy {
  private readonly windows = new Map<string, Candle[]>();

  constructor(private readonly model: TrainedModel) {}

  onCandle(candle: Candle): Signal {
    const key = `${candle.symbol}:${candle.timeframe}`;
    const series = this.windows.get(key) ?? [];
    series.push(candle);
    if (series.length > Math.max(128, featureLookback + 8)) {
      series.splice(0, series.length - Math.max(128, featureLookback + 8));
    }
    this.windows.set(key, series);

    if (series.length < featureLookback) {
      return {
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        action: 'hold',
        strength: 0,
        reason: 'not enough history',
        timestamp: Date.now(),
      };
    }

    const window = series.slice(series.length - featureLookback);
    const features = extractFeatures(window, [], {
      position: 0,
      positionAge: 0,
      lastTurnoverAge: 0,
    });
    const probLong = this.predictProbability(features);

    let action: Signal['action'] = 'hold';
    let reason = 'neutral prediction';
    if (probLong >= 0.55) {
      action = 'buy';
      reason = 'supervised long signal';
    } else if (probLong <= 0.45) {
      action = 'sell';
      reason = 'supervised short signal';
    }

    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      action,
      strength: Math.min(1, Math.abs(probLong - 0.5) * 2),
      reason,
      timestamp: Date.now(),
    };
  }

  private predictProbability(features: number[]): number {
    const z = features.reduce(
      (sum, feature, idx) => sum + feature * (this.model.weights[idx] ?? 0),
      this.model.bias,
    );
    return 1 / (1 + Math.exp(-z));
  }
}
