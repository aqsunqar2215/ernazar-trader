import { FEATURE_NAMES } from './features.js';

export const RL_ACTIONS = ['sell', 'hold', 'buy'] as const;
export type RlActionLabel = (typeof RL_ACTIONS)[number];
export type RlActionValue = -1 | 0 | 1;
export type RlRegime = 'trend' | 'mean';

interface RegimeHead {
  qWeights: number[][];
  qBias: number[];
}

export interface RlLinearQPolicyModel {
  kind: 'rl_linear_q';
  featureNames: string[];
  qWeights: number[][];
  qBias: number[];
  epsilon: number;
  regimeHeads?: {
    trend: RegimeHead;
    mean: RegimeHead;
  };
}

export const actionIndexToValue = (index: number): RlActionValue => {
  if (index <= 0) return -1;
  if (index >= 2) return 1;
  return 0;
};

export const actionValueToIndex = (value: RlActionValue): number => {
  if (value < 0) return 0;
  if (value > 0) return 2;
  return 1;
};

export const actionIndexToLabel = (index: number): RlActionLabel => RL_ACTIONS[Math.max(0, Math.min(2, index))];

export const scoreActions = (features: number[], model: RlLinearQPolicyModel): number[] => {
  const scores = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    let value = model.qBias[a] ?? 0;
    const weights = model.qWeights[a] ?? [];
    for (let i = 0; i < features.length; i += 1) {
      value += (weights[i] ?? 0) * features[i];
    }
    scores[a] = value;
  }
  return scores;
};

const getRegimeHead = (model: RlLinearQPolicyModel, regime: RlRegime): RegimeHead => {
  if (!model.regimeHeads) {
    return { qWeights: model.qWeights, qBias: model.qBias };
  }
  return model.regimeHeads[regime] ?? { qWeights: model.qWeights, qBias: model.qBias };
};

export const scoreActionsForRegime = (
  features: number[],
  model: RlLinearQPolicyModel,
  regime: RlRegime,
): number[] => {
  const head = getRegimeHead(model, regime);
  const scores = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    let value = head.qBias[a] ?? 0;
    const weights = head.qWeights[a] ?? [];
    for (let i = 0; i < features.length; i += 1) {
      value += (weights[i] ?? 0) * features[i];
    }
    scores[a] = value;
  }
  return scores;
};

export const greedyActionIndex = (features: number[], model: RlLinearQPolicyModel): number => {
  const scores = scoreActions(features, model);
  let best = 1;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] > scores[best]) best = i;
  }
  return best;
};

export const greedyActionIndexForRegime = (
  features: number[],
  model: RlLinearQPolicyModel,
  regime: RlRegime,
): number => {
  const scores = scoreActionsForRegime(features, model, regime);
  let best = 1;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] > scores[best]) best = i;
  }
  return best;
};

export const classifyRegime = (features: number[], featureNames: string[]): RlRegime => {
  const idx = (name: string): number => featureNames.indexOf(name);
  const safe = (name: string): number => {
    const index = idx(name);
    if (index < 0 || index >= features.length) return 0;
    const value = features[index];
    return Number.isFinite(value) ? value : 0;
  };
  const retAutocorr = safe('returns_autocorr');
  const ema34Dist = safe('ema34_dist');
  const hurstProxy = safe('hurst_proxy');
  const trendSignal = retAutocorr > 0.15 && (Math.abs(ema34Dist) > 0.002 || hurstProxy > 0.55);
  return trendSignal ? 'trend' : 'mean';
};

const topTwo = (scores: number[]): { best: number; second: number } => {
  let best = 0;
  let second = 1;
  if (scores[1] > scores[0]) {
    best = 1;
    second = 0;
  }
  if (scores[2] > scores[best]) {
    second = best;
    best = 2;
  } else if (scores[2] > scores[second]) {
    second = 2;
  }
  return { best, second };
};

export const selectActionWithConfidence = (params: {
  features: number[];
  model: RlLinearQPolicyModel;
  epsilon?: number;
  confidenceGateEnabled?: boolean;
  confidenceQGap?: number;
  regime?: RlRegime;
}): { actionIdx: number; qGap: number; scores: number[]; regime: RlRegime; gateTriggered: boolean } => {
  const {
    features,
    model,
    epsilon = 0,
    confidenceGateEnabled = false,
    confidenceQGap = 0,
    regime,
  } = params;
  const resolvedRegime = regime ?? classifyRegime(features, model.featureNames);
  const scores = scoreActionsForRegime(features, model, resolvedRegime);
  const { best, second } = topTwo(scores);
  const qGap = scores[best] - scores[second];
  const actionIdx = Math.random() < epsilon ? Math.floor(Math.random() * 3) : best;
  const gateTriggered = confidenceGateEnabled && qGap < confidenceQGap;
  return { actionIdx, qGap, scores, regime: resolvedRegime, gateTriggered };
};

// Xavier-like init: break symmetry so all 3 actions start with different Q-values.
// Without this every action scores 0, td-error is pure reward noise and the agent
// cannot tell buy from sell from hold even after thousands of steps.
const xavierInit = (fanIn: number): number => {
  const limit = Math.sqrt(6 / (fanIn + 1));
  return (Math.random() * 2 - 1) * limit;
};

export const createEmptyRlPolicy = (): RlLinearQPolicyModel => ({
  kind: 'rl_linear_q',
  featureNames: [...FEATURE_NAMES],
  qWeights: Array.from({ length: 3 }, () =>
    Array.from({ length: FEATURE_NAMES.length }, () => xavierInit(FEATURE_NAMES.length)),
  ),
  // Small bias: sell slightly bias positive, hold neutral, buy slightly positive.
  // Keeps early exploration balanced rather than random holdShare=100%.
  qBias: [-0.01, 0.0, 0.01],
  epsilon: 0.4,
});
