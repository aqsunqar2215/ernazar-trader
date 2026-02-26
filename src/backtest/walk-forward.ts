import type { Candle } from '../core/types.js';
import { BacktestEngine, type BacktestOptions, type BacktestResult } from './engine.js';

export interface WalkForwardFoldResult {
  fold: number;
  trainRange: [number, number];
  testRange: [number, number];
  result: BacktestResult;
}

export interface WalkForwardSummary {
  folds: WalkForwardFoldResult[];
  avgSharpe: number;
  avgSortino: number;
  avgProfitFactor: number;
  avgWinRate: number;
  avgNetPnl: number;
  maxDrawdown: number;
}

export class WalkForwardValidator {
  constructor(private readonly backtest: BacktestEngine) {}

  validate(candles: Candle[], options: BacktestOptions, folds: number = 4): WalkForwardSummary {
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < 300) {
      return {
        folds: [],
        avgSharpe: 0,
        avgSortino: 0,
        avgProfitFactor: 0,
        avgWinRate: 0,
        avgNetPnl: 0,
        maxDrawdown: 0,
      };
    }

    const foldResults: WalkForwardFoldResult[] = [];
    const segment = Math.floor(sorted.length / (folds + 1));
    for (let i = 0; i < folds; i += 1) {
      const trainStart = 0;
      const trainEnd = segment * (i + 1);
      const testStart = trainEnd;
      const testEnd = Math.min(sorted.length, testStart + segment);
      const testSlice = sorted.slice(testStart, testEnd);
      if (testSlice.length < 80) continue;

      const result = this.backtest.run(testSlice, options);
      foldResults.push({
        fold: i + 1,
        trainRange: [sorted[trainStart].openTime, sorted[Math.max(trainStart, trainEnd - 1)].openTime],
        testRange: [sorted[testStart].openTime, sorted[Math.max(testStart, testEnd - 1)].openTime],
        result,
      });
    }

    if (foldResults.length === 0) {
      return {
        folds: [],
        avgSharpe: 0,
        avgSortino: 0,
        avgProfitFactor: 0,
        avgWinRate: 0,
        avgNetPnl: 0,
        maxDrawdown: 0,
      };
    }

    const avg = (selector: (item: WalkForwardFoldResult) => number): number =>
      foldResults.reduce((sum, item) => sum + selector(item), 0) / foldResults.length;

    return {
      folds: foldResults,
      avgSharpe: avg(item => item.result.sharpe),
      avgSortino: avg(item => item.result.sortino),
      avgProfitFactor: avg(item => item.result.profitFactor),
      avgWinRate: avg(item => item.result.winRate),
      avgNetPnl: avg(item => item.result.netPnl),
      maxDrawdown: Math.max(...foldResults.map(item => item.result.maxDrawdown)),
    };
  }
}
