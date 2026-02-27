import type { Candle, Signal } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { extractFeatures, featureLookback, FEATURE_NAMES } from '../ml/features.js';
import { actionIndexToLabel, greedyActionIndex, scoreActions, type RlLinearQPolicyModel } from '../ml/rl-policy.js';
import type { Strategy } from './strategy.js';

interface SymbolState {
  step: number;
  position: -1 | 0 | 1;
  positionEntryStep: number;
  lastTurnoverStep: number;
  candles: Candle[];
}

export class RlPolicyStrategy implements Strategy {
  private readonly logger: Logger;
  private readonly states = new Map<string, SymbolState>();

  constructor(
    private readonly db: StateDb,
    private model: RlLinearQPolicyModel,
    logger: Logger,
  ) {
    this.logger = logger.child('rl-policy-strategy');
  }

  updateModel(model: RlLinearQPolicyModel): void {
    this.model = model;
  }

  onCandle(candle: Candle): Signal {
    const key = `${candle.symbol}:${candle.timeframe}`;
    const state = this.states.get(key) ?? {
      step: 0,
      position: 0,
      positionEntryStep: 0,
      lastTurnoverStep: 0,
      candles: [],
    };

    state.step += 1;
    state.candles.push(candle);
    if (state.candles.length > Math.max(400, featureLookback + 4)) {
      state.candles.splice(0, state.candles.length - Math.max(400, featureLookback + 4));
    }

    const dbPosition = this.lookupPosition(candle.symbol);
    if (dbPosition !== state.position) {
      state.position = dbPosition;
      state.positionEntryStep = state.step;
      state.lastTurnoverStep = state.step;
    }

    this.states.set(key, state);

    if (state.candles.length < featureLookback) {
      return {
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        action: 'hold',
        strength: 0,
        reason: 'rl policy waiting for history',
        timestamp: Date.now(),
      };
    }

    const window = state.candles.slice(state.candles.length - featureLookback);
    const positionAge = state.position === 0 ? 0 : Math.max(0, state.step - state.positionEntryStep);
    const lastTurnoverAge = Math.max(0, state.step - state.lastTurnoverStep);
    const rawFeatures = extractFeatures(window, [], {
      position: state.position,
      positionAge,
      lastTurnoverAge,
    });
    const features = alignFeatures(rawFeatures, this.model.featureNames);
    const scores = scoreActions(features, this.model);
    const actionIndex = greedyActionIndex(features, this.model);
    const action = actionIndexToLabel(actionIndex);
    const strength = action === 'hold' ? 0 : scoreToStrength(scores, actionIndex);

    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      action,
      strength,
      reason: 'rl policy',
      timestamp: Date.now(),
    };
  }

  private lookupPosition(symbol: string): -1 | 0 | 1 {
    const position = this.db.getPositions().find(item => item.symbol === symbol);
    if (!position) return 0;
    if (position.quantity > 0) return 1;
    if (position.quantity < 0) return -1;
    return 0;
  }
}

const alignFeatures = (features: number[], modelFeatureNames: string[]): number[] => {
  if (modelFeatureNames.length === 0) return features;
  return modelFeatureNames.map(name => {
    const idx = FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    if (idx < 0 || idx >= features.length) return 0;
    return features[idx];
  });
};

const scoreToStrength = (scores: number[], bestIdx: number): number => {
  const maxScore = Math.max(...scores);
  const exp = scores.map(score => Math.exp(score - maxScore));
  const total = exp.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const probs = exp.map(value => value / total);
  const bestProb = probs[bestIdx] ?? 0;
  return Math.min(1, Math.abs(bestProb - 1 / 3) * 1.6);
};
