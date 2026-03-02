import { randomUUID } from 'node:crypto';
import type { TrainingSample } from './dataset-builder.js';
import { FEATURE_NAMES } from './features.js';

export interface TrainedModel {
  id: string;
  createdAt: number;
  featureNames: string[];
  weights: number[];
  bias: number;
  kind?: 'supervised_linear' | 'rl_linear_q';
  qWeights?: number[][];
  qBias?: number[];
  regimeHeads?: {
    trend: { qWeights: number[][]; qBias: number[] };
    mean: { qWeights: number[][]; qBias: number[] };
  };
  training?: Record<string, number | string>;
  metrics: {
    accuracy: number;
    f1: number;
    precision: number;
    recall: number;
  };
}

export class BatchTrainer {
  private readonly featureNames = [...FEATURE_NAMES];

  train(samples: TrainingSample[]): TrainedModel {
    const filtered = samples.filter(sample => sample.label !== 0);
    if (filtered.length < 100) {
      return {
        id: randomUUID(),
        createdAt: Date.now(),
        featureNames: this.featureNames,
        weights: new Array(this.featureNames.length).fill(0),
        bias: 0,
        kind: 'supervised_linear',
        metrics: { accuracy: 0, f1: 0, precision: 0, recall: 0 },
      };
    }

    const positives = filtered.filter(sample => sample.label > 0);
    const negatives = filtered.filter(sample => sample.label < 0);
    const posMeans = meanVector(positives);
    const negMeans = meanVector(negatives);
    const weights = posMeans.map((value, idx) => value - negMeans[idx]);
    const prior = positives.length / filtered.length;
    const bias = Math.log(Math.max(1e-6, prior / Math.max(1e-6, 1 - prior)));

    const predictions = filtered.map(sample => this.predictLabel(sample.features, weights, bias));
    const metrics = classificationMetrics(
      filtered.map(sample => (sample.label > 0 ? 1 : 0)),
      predictions.map(pred => (pred > 0 ? 1 : 0)),
    );

    return {
      id: randomUUID(),
      createdAt: Date.now(),
      featureNames: this.featureNames,
      weights,
      bias,
      kind: 'supervised_linear',
      metrics,
    };
  }

  score(features: number[], model: TrainedModel): number {
    return this.predictProbability(features, model.weights, model.bias);
  }

  private predictLabel(features: number[], weights: number[], bias: number): number {
    const p = this.predictProbability(features, weights, bias);
    return p >= 0.5 ? 1 : -1;
  }

  private predictProbability(features: number[], weights: number[], bias: number): number {
    const z = features.reduce((sum, feature, idx) => sum + feature * (weights[idx] ?? 0), bias);
    return 1 / (1 + Math.exp(-z));
  }
}

const meanVector = (samples: TrainingSample[]): number[] => {
  if (samples.length === 0) return [];
  const dims = samples[0].features.length;
  const sum = new Array(dims).fill(0);
  for (const sample of samples) {
    for (let i = 0; i < dims; i += 1) {
      sum[i] += sample.features[i];
    }
  }
  return sum.map(value => value / samples.length);
};

const classificationMetrics = (truth: number[], pred: number[]): { accuracy: number; f1: number; precision: number; recall: number } => {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < truth.length; i += 1) {
    const y = truth[i];
    const p = pred[i];
    if (y === 1 && p === 1) tp += 1;
    else if (y === 0 && p === 0) tn += 1;
    else if (y === 0 && p === 1) fp += 1;
    else fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const accuracy = truth.length === 0 ? 0 : (tp + tn) / truth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { accuracy, f1, precision, recall };
};
