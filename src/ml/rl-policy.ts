import { FEATURE_NAMES } from './features.js';

export const RL_ACTIONS = ['sell', 'hold', 'buy'] as const;
export type RlActionLabel = (typeof RL_ACTIONS)[number];
export type RlActionValue = -1 | 0 | 1;

export interface RlLinearQPolicyModel {
  kind: 'rl_linear_q';
  featureNames: string[];
  qWeights: number[][];
  qBias: number[];
  epsilon: number;
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

export const greedyActionIndex = (features: number[], model: RlLinearQPolicyModel): number => {
  const scores = scoreActions(features, model);
  let best = 1;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] > scores[best]) best = i;
  }
  return best;
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
