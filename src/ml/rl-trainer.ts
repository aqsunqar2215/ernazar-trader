import type { Candle } from '../core/types.js';
import { featureLookback, extractFeatures } from './features.js';
import {
  actionIndexToLabel,
  actionIndexToValue,
  actionValueToIndex,
  createEmptyRlPolicy,
  greedyActionIndex,
  scoreActions,
  type RlLinearQPolicyModel,
} from './rl-policy.js';

export interface RlBacktestTrade {
  entryTs: number;
  exitTs: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
}

export interface RlSimulationResult {
  netPnl: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  winRate: number;
  profitFactor: number;
  trades: RlBacktestTrade[];
  equityCurve: number[];
  totalReward: number;
}

export interface RlTrainerOptions {
  episodes: number;
  minEpisodes: number;
  earlyStopPatience: number;
  earlyStopMinDelta: number;
  learningRate: number;
  gamma: number;
  epsilonStart: number;
  epsilonEnd: number;
  feeBps: number;
  slippageBps: number;
  latencyBars: number;
  riskPerTradePct: number;
  turnoverPenaltyBps: number;
  drawdownPenaltyFactor: number;
  rewardCostWeight: number;
  rewardHoldPenalty: number;
  rewardActionBonus: number;
  regimeBalanced: boolean;
  regimeLookbackBars: number;
  regimeEpisodeBars: number;
  regimeStrideBars: number;
}

export interface RlTrainOutput {
  model: RlLinearQPolicyModel;
  training: {
    episodes: number;
    bestEpisodeReward: number;
    finalEpisodeReward: number;
    avgEpisodeReward: number;
    avgShapedPnlPerStep: number;
    avgCostsPerStep: number;
    avgDdPenaltyPerStep: number;
    avgTurnoverPerStep: number;
    buyShare: number;
    sellShare: number;
    holdShare: number;
  };
  inSample: RlSimulationResult;
}

export interface RlWalkForwardFold {
  fold: number;
  trainRange: [number, number];
  testRange: [number, number];
  trainedEpisodes: number;
  trainAvgEpisodeReward: number;
  result: RlSimulationResult;
}

export interface RlWalkForwardSummary {
  folds: RlWalkForwardFold[];
  avgSharpe: number;
  avgSortino: number;
  avgProfitFactor: number;
  avgWinRate: number;
  avgNetPnl: number;
  maxDrawdown: number;
}

interface EpisodeState {
  symbol: string;
  position: -1 | 0 | 1;
  entryPrice: number;
  entryTs: number;
  pendingAction: Array<{ executeAt: number; action: -1 | 0 | 1 }>;
}

interface SimulatorOptions {
  initialCapitalUsd: number;
  feeBps: number;
  slippageBps: number;
  latencyBars: number;
  riskPerTradePct: number;
  turnoverPenaltyBps: number;
  drawdownPenaltyFactor: number;
}

interface RlEpisodeTelemetry {
  totalReward: number;
  steps: number;
  totalShapedPnl: number;
  totalCosts: number;
  totalDdPenalty: number;
  totalTurnover: number;
  buyDecisions: number;
  sellDecisions: number;
  holdDecisions: number;
}

type RegimeName = 'trend' | 'flat' | 'volatile';

interface RegimeWindowPlan {
  trendStarts: number[];
  flatStarts: number[];
  volatileStarts: number[];
  windowBars: number;
}

const defaultTrainerOptions: RlTrainerOptions = {
  episodes: 180,
  minEpisodes: 80,
  earlyStopPatience: 35,
  earlyStopMinDelta: 0.0004,
  learningRate: 0.02,
  gamma: 0.97,
  epsilonStart: 0.35,
  epsilonEnd: 0.05,
  feeBps: 4,
  slippageBps: 2,
  latencyBars: 1,
  riskPerTradePct: 0.8,
  turnoverPenaltyBps: 0.2,
  drawdownPenaltyFactor: 0.05,
  rewardCostWeight: 0.5,
  rewardHoldPenalty: 0.00012,
  rewardActionBonus: 0.00005,
  regimeBalanced: true,
  regimeLookbackBars: 96,
  regimeEpisodeBars: 320,
  regimeStrideBars: 6,
};

const defaultSimulatorOptions: SimulatorOptions = {
  initialCapitalUsd: 10_000,
  feeBps: 4,
  slippageBps: 2,
  latencyBars: 1,
  riskPerTradePct: 0.8,
  turnoverPenaltyBps: 0.1,
  drawdownPenaltyFactor: 0.02,
};

// Reward shaping bands tuned for NORMALISED returns (pnl/notional, not raw USD).
// Typical 1-min BTC return ~0.0001–0.001 range, so bands are calibrated accordingly.
// Asymmetric: reward wins more than punish losses to encourage active trading.
const pnlRewardBands = {
  positive: [
    { maxAbsPnlUsd: 0.00005, multiplier: 1.0 },
    { maxAbsPnlUsd: 0.0003, multiplier: 1.2 },
    { maxAbsPnlUsd: 0.001, multiplier: 1.5 },
    { maxAbsPnlUsd: Number.POSITIVE_INFINITY, multiplier: 2.0 },
  ],
  negative: [
    { maxAbsPnlUsd: 0.00005, multiplier: 0.7 },
    { maxAbsPnlUsd: 0.0003, multiplier: 0.85 },
    { maxAbsPnlUsd: 0.001, multiplier: 1.0 },
    { maxAbsPnlUsd: Number.POSITIVE_INFINITY, multiplier: 1.1 },
  ],
} as const;

// Experience replay buffer: stores (state, action, reward, nextState) tuples.
// Mini-batch sampling breaks temporal correlations and stabilises linear Q-learning.
const REPLAY_BUFFER_SIZE = 3_000;
const REPLAY_BATCH_SIZE = 32;
const TARGET_NETWORK_UPDATE_FREQ = 25; // episodes between target weight freeze

interface ReplayEntry {
  features: number[];
  actionIdx: number;
  reward: number;
  nextFeatures: number[];
  done: boolean;
}

export class RlTrainer {
  train(
    candles: Candle[],
    options: Partial<RlTrainerOptions> = {},
    initialModel?: RlLinearQPolicyModel,
  ): RlTrainOutput {
    // Reset stateful properties to prevent cross-iteration leakage.
    this.replayBuffer = [];
    this.targetWeights = [];
    this.targetBias = [];
    this.targetEpisode = -1;
    const cfg = { ...defaultTrainerOptions, ...options };
    const model = isCompatiblePolicy(initialModel) ? clonePolicy(initialModel) : createEmptyRlPolicy();
    const grouped = groupBySymbol(candles);
    const keys = [...grouped.keys()];
    if (keys.length === 0) {
      return {
        model,
        training: {
          episodes: 0,
          bestEpisodeReward: 0,
          finalEpisodeReward: 0,
          avgEpisodeReward: 0,
          avgShapedPnlPerStep: 0,
          avgCostsPerStep: 0,
          avgDdPenaltyPerStep: 0,
          avgTurnoverPerStep: 0,
          buyShare: 0,
          sellShare: 0,
          holdShare: 1,
        },
        inSample: this.evaluate(candles, model),
      };
    }

    const episodeRewards: number[] = [];
    const telemetryRows: RlEpisodeTelemetry[] = [];
    const regimePlans = cfg.regimeBalanced ? buildRegimePlans(grouped, cfg) : new Map<string, RegimeWindowPlan>();
    let bestReward = Number.NEGATIVE_INFINITY;
    let lastReward = 0;
    let bestWeights = cloneWeights(model.qWeights);
    let bestBias = [...model.qBias];
    let episodesRan = 0;
    let stagnantEpisodes = 0;
    const episodeCount = Math.max(1, cfg.episodes - 1);
    for (let episode = 0; episode < cfg.episodes; episode += 1) {
      const epsilon = linearSchedule(cfg.epsilonStart, cfg.epsilonEnd, episode, episodeCount);
      const learningRate = linearSchedule(
        cfg.learningRate,
        Math.max(0.005, cfg.learningRate * 0.35),
        episode,
        episodeCount,
      );
      model.epsilon = epsilon;
      const telemetry = this.runTrainingEpisode(grouped, keys, model, cfg, epsilon, learningRate, episode, regimePlans);
      telemetryRows.push(telemetry);
      episodeRewards.push(telemetry.totalReward);
      episodesRan += 1;
      if (telemetry.totalReward > bestReward + cfg.earlyStopMinDelta) {
        bestReward = telemetry.totalReward;
        bestWeights = cloneWeights(model.qWeights);
        bestBias = [...model.qBias];
        stagnantEpisodes = 0;
      } else {
        stagnantEpisodes += 1;
      }
      lastReward = telemetry.totalReward;

      const enoughEpisodes = episodesRan >= Math.max(1, Math.min(cfg.minEpisodes, cfg.episodes));
      if (enoughEpisodes && stagnantEpisodes >= Math.max(1, cfg.earlyStopPatience)) {
        console.log(
          `[RlTrainer] Early stopping at episode ${episodesRan}/${cfg.episodes}: ` +
            `${stagnantEpisodes} stagnant episodes (patience=${cfg.earlyStopPatience}), ` +
            `bestReward=${bestReward.toFixed(6)}, lastReward=${lastReward.toFixed(6)}`,
        );
        break;
      }
    }

    // Keep the best-performing checkpoint across episodes instead of blindly using the final step.
    model.qWeights = bestWeights;
    model.qBias = bestBias;
    model.epsilon = 0;
    const inSample = this.evaluate(candles, model, cfg);
    return {
      model,
      training: {
        episodes: episodesRan,
        bestEpisodeReward: Number.isFinite(bestReward) ? bestReward : 0,
        finalEpisodeReward: lastReward,
        avgEpisodeReward: avg(episodeRewards),
        ...aggregateEpisodeTelemetry(telemetryRows),
      },
      inSample,
    };
  }

  evaluate(candles: Candle[], model: RlLinearQPolicyModel, options: Partial<SimulatorOptions> = {}): RlSimulationResult {
    const cfg = { ...defaultSimulatorOptions, ...options };
    return simulatePolicy(candles, model, cfg);
  }

  walkForward(
    candles: Candle[],
    model: RlLinearQPolicyModel,
    options: Partial<SimulatorOptions> = {},
    folds: number = 4,
    trainOptions: Partial<RlTrainerOptions> = {},
    purgeBars: number = 100,
  ): RlWalkForwardSummary {
    const cfg = { ...defaultSimulatorOptions, ...options };
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < 350) {
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

    const foldResults: RlWalkForwardFold[] = [];
    const segment = Math.floor(sorted.length / (folds + 1));
    for (let i = 0; i < folds; i += 1) {
      const trainEnd = segment * (i + 1);
      const testStart = trainEnd + Math.max(0, purgeBars);
      const testEnd = Math.min(sorted.length, testStart + segment);
      const trainSlice = sorted.slice(0, trainEnd);
      const testSlice = sorted.slice(testStart, testEnd);
      if (trainSlice.length < 240 || testSlice.length < 80) continue;

      const foldTraining = this.train(trainSlice, trainOptions);
      const result = simulatePolicy(testSlice, foldTraining.model, cfg);
      foldResults.push({
        fold: i + 1,
        trainRange: [sorted[0].openTime, sorted[Math.max(0, trainEnd - 1)].openTime],
        testRange: [sorted[testStart].openTime, sorted[Math.max(testStart, testEnd - 1)].openTime],
        trainedEpisodes: foldTraining.training.episodes,
        trainAvgEpisodeReward: foldTraining.training.avgEpisodeReward,
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

    return {
      folds: foldResults,
      avgSharpe: avg(foldResults.map(item => item.result.sharpe)),
      avgSortino: avg(foldResults.map(item => item.result.sortino)),
      avgProfitFactor: avg(foldResults.map(item => item.result.profitFactor)),
      avgWinRate: avg(foldResults.map(item => item.result.winRate)),
      avgNetPnl: avg(foldResults.map(item => item.result.netPnl)),
      maxDrawdown: Math.max(...foldResults.map(item => item.result.maxDrawdown)),
    };
  }

  // Experience replay buffer shared across calls (module-level via closure on instance).
  // Linear Q agents suffer from correlated updates; mini-batch replay breaks the
  // temporal correlation and dramatically improves sample efficiency.
  private replayBuffer: ReplayEntry[] = [];
  // Frozen target weights updated every TARGET_NETWORK_UPDATE_FREQ episodes.
  // Using live weights for maxNext causes instability ("chasing a moving target").
  private targetWeights: number[][] = [];
  private targetBias: number[] = [];
  private targetEpisode = -1;

  private runTrainingEpisode(
    grouped: Map<string, Candle[]>,
    symbols: string[],
    model: RlLinearQPolicyModel,
    cfg: RlTrainerOptions,
    epsilon: number,
    learningRate: number,
    episodeIndex: number,
    regimePlans: Map<string, RegimeWindowPlan>,
  ): RlEpisodeTelemetry {
    // Update target network every N episodes.
    if (episodeIndex === 0 || episodeIndex - this.targetEpisode >= TARGET_NETWORK_UPDATE_FREQ) {
      this.targetWeights = cloneWeights(model.qWeights);
      this.targetBias = [...model.qBias];
      this.targetEpisode = episodeIndex;
    }

    let totalReward = 0;
    let totalShapedPnl = 0;
    let totalCosts = 0;
    let totalDdPenalty = 0;
    let totalTurnover = 0;
    let steps = 0;
    let buyDecisions = 0;
    let sellDecisions = 0;
    let holdDecisions = 0;
    const symbolOrder = shuffle(symbols);
    for (const symbol of symbolOrder) {
      const series = grouped.get(symbol);
      if (!series) continue;
      if (series.length < featureLookback + 2) continue;
      const regimePlan = regimePlans.get(symbol);
      const [startIdx, endIdx] = pickEpisodeRange(
        series.length,
        regimePlan,
        episodeIndex,
      );
      let equity = 10_000 / Math.max(1, grouped.size);
      let peak = equity;
      const state: EpisodeState = {
        symbol,
        position: 0,
        entryPrice: 0,
        entryTs: 0,
        pendingAction: [],
      };
      let lastPositionChangeBar = startIdx;

      for (let i = startIdx; i < endIdx; i += 1) {
        const window = series.slice(i - (featureLookback - 1), i + 1);
        const features = extractFeatures(window);
        const actionIdx = chooseAction(features, model, epsilon);
        const action = actionIndexToValue(actionIdx);
        if (action === 1) buyDecisions += 1;
        else if (action === -1) sellDecisions += 1;
        else holdDecisions += 1;
        state.pendingAction.push({
          executeAt: i + Math.max(0, cfg.latencyBars),
          action,
        });

        let costs = 0;
        let turnoverApplied = 0;
        while (state.pendingAction.length > 0 && state.pendingAction[0].executeAt <= i) {
          const update = state.pendingAction.shift();
          if (!update) break;
          const turnover = Math.abs(update.action - state.position);
          if (turnover <= 0) continue;
          turnoverApplied += turnover;
          const notional = equity * (cfg.riskPerTradePct / 100) * Math.max(0.2, Math.abs(update.action));
          const dynamicSlippageBps = cfg.slippageBps + Math.max(0, features[1]) * 4;
          const feeCost = notional * ((cfg.feeBps + dynamicSlippageBps) / 10_000) * turnover;
          const turnoverPenalty = notional * (cfg.turnoverPenaltyBps / 10_000) * turnover;
          costs += feeCost + turnoverPenalty;
          state.position = update.action;
          if (state.position !== 0) {
            state.entryPrice = series[i].close;
            state.entryTs = series[i].openTime;
          } else {
            state.entryPrice = 0;
            state.entryTs = 0;
          }
        }

        const positionChanged = turnoverApplied > 0;
        const tooFrequent = positionChanged && i - lastPositionChangeBar < 3;
        const frequencyPenalty = tooFrequent ? 0.001 : 0;
        if (positionChanged) {
          lastPositionChangeBar = i;
        }

        const next = series[i + 1];
        const priceRet = (next.close - series[i].close) / Math.max(1e-9, series[i].close);
        const stepNotional = equity * (cfg.riskPerTradePct / 100) * Math.max(0.2, Math.abs(state.position));
        const pnl = stepNotional * state.position * priceRet;
        equity += pnl - costs;
        peak = Math.max(peak, equity);
        const drawdown = peak <= 0 ? 0 : (peak - equity) / peak;
        const ddPenalty = drawdown * cfg.drawdownPenaltyFactor;
const normalizationBase = Math.max(1e-6, stepNotional);
const pnlReturn = pnl / normalizationBase;
const normalizedCosts = costs / normalizationBase;
const shapedPnl = shapePnlReward(pnlReturn);
// TD reward now includes the same cost/drawdown signals that the evaluator uses.
// This aligns what the agent optimises with how it is scored.
// - `pnlReturn`: normalised position PnL (replaces raw `position * priceRet`)
// - `normalizedCosts * rewardCostWeight`: penalises each trade proportionally
// - `ddPenalty`: discourages policies that cause large drawdowns
// - `frequencyPenalty`: existing penalty for flipping too fast
const reward = pnlReturn
  - normalizedCosts * cfg.rewardCostWeight
  - ddPenalty
  - frequencyPenalty;
// `shapedPnl` is the bounded economic PnL metric (via pnlRewardBands).
// Used only for telemetry/logging, not for TD updates.
        totalReward += reward;
        totalShapedPnl += shapedPnl;
        totalCosts += normalizedCosts;
        totalDdPenalty += ddPenalty;
        totalTurnover += turnoverApplied;
        steps += 1;

        // Collect next-state features regardless of episode end.
        const nextWindow = series.slice(i - (featureLookback - 2), i + 2);
        const nextFeatures = extractFeatures(nextWindow);
        const isDone = i + 1 >= endIdx;

        // --- Push to replay buffer (circular) ---
        this.replayBuffer.push({ features, actionIdx, reward, nextFeatures, done: isDone });
        if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
          this.replayBuffer.shift();
        }

        // --- Online TD update on current transition ---
        this.applyTdUpdate(model, features, actionIdx, reward, nextFeatures, isDone, cfg, learningRate);

        // --- Mini-batch replay update (every step once buffer has enough entries) ---
        if (this.replayBuffer.length >= REPLAY_BATCH_SIZE) {
          const batch = sampleBatch(this.replayBuffer, REPLAY_BATCH_SIZE);
          for (const entry of batch) {
            this.applyTdUpdate(model, entry.features, entry.actionIdx, entry.reward, entry.nextFeatures, entry.done, cfg, learningRate * 0.5);
          }
        }
      }
    }
    return {
      totalReward,
      steps,
      totalShapedPnl,
      totalCosts,
      totalDdPenalty,
      totalTurnover,
      buyDecisions,
      sellDecisions,
      holdDecisions,
    };
  }

  private applyTdUpdate(
    model: RlLinearQPolicyModel,
    features: number[],
    actionIdx: number,
    reward: number,
    nextFeatures: number[],
    done: boolean,
    cfg: RlTrainerOptions,
    learningRate: number,
  ): void {
    const qNow = scoreActions(features, model);
    // Use frozen TARGET weights for next-state value to stabilise learning.
    const qNextTarget = scoreActionsWithWeights(nextFeatures, this.targetWeights, this.targetBias);
    const maxNext = done ? 0 : Math.max(...qNextTarget);
    const td = reward + cfg.gamma * maxNext - qNow[actionIdx];
    // Tighter TD clip [-2, 2] since rewards are now normalised ~[-0.01, 0.01].
    const clippedTd = clamp(td, -2, 2);
    const wRow = model.qWeights[actionIdx];
    for (let j = 0; j < features.length; j += 1) {
      wRow[j] += learningRate * clippedTd * features[j];
    }
    model.qBias[actionIdx] += learningRate * clippedTd;
  }
}

export const simulatePolicy = (
  candles: Candle[],
  model: RlLinearQPolicyModel,
  options: Partial<SimulatorOptions> = {},
): RlSimulationResult => {
  const cfg = { ...defaultSimulatorOptions, ...options };
  const grouped = groupBySymbol(candles);
  const symbols = [...grouped.keys()];
  if (symbols.length === 0) {
    return {
      netPnl: 0,
      maxDrawdown: 0,
      sharpe: 0,
      sortino: 0,
      winRate: 0,
      profitFactor: 0,
      trades: [],
      equityCurve: [cfg.initialCapitalUsd],
      totalReward: 0,
    };
  }

  const states = new Map<string, EpisodeState>();
  const symbolCapital = new Map<string, number>();
  for (const symbol of symbols) {
    symbolCapital.set(symbol, cfg.initialCapitalUsd / symbols.length);
    states.set(symbol, {
      symbol,
      position: 0,
      entryPrice: 0,
      entryTs: 0,
      pendingAction: [],
    });
  }

  const globalSeries = [...candles]
    .filter(candle => candle.timeframe === '1m')
    .sort((a, b) => a.openTime - b.openTime || a.symbol.localeCompare(b.symbol));

  const bySymbol = groupBySymbol(globalSeries);
  const trades: RlBacktestTrade[] = [];
  const rewardSeries: number[] = [];
  const equityCurve: number[] = [cfg.initialCapitalUsd];
  let peak = cfg.initialCapitalUsd;
  let maxDrawdown = 0;
  let totalReward = 0;

  for (const [symbol, series] of bySymbol.entries()) {
    const state = states.get(symbol);
    if (!state || series.length < featureLookback + 2) continue;
    let equity = symbolCapital.get(symbol) ?? cfg.initialCapitalUsd / symbols.length;

    for (let i = featureLookback - 1; i < series.length - 1; i += 1) {
      const window = series.slice(i - (featureLookback - 1), i + 1);
      const features = extractFeatures(window);
      const actionIdx = greedyActionIndex(features, model);
      const action = actionIndexToValue(actionIdx);
      state.pendingAction.push({ executeAt: i + Math.max(1, cfg.latencyBars), action });

      let costs = 0;
      while (state.pendingAction.length > 0 && state.pendingAction[0].executeAt <= i) {
        const update = state.pendingAction.shift();
        if (!update) break;
        const turnover = Math.abs(update.action - state.position);
        if (turnover <= 0) continue;
        if (state.position !== 0) {
          const closed = closeTrade(state, series[i], equity * (cfg.riskPerTradePct / 100));
          if (closed) trades.push(closed);
        }
        const notional = equity * (cfg.riskPerTradePct / 100) * Math.max(0.2, Math.abs(update.action));
        const dynamicSlippageBps = cfg.slippageBps + Math.max(0, features[1]) * 8 + Math.max(0, features[5]) * 2;
        const feeCost = notional * ((cfg.feeBps + dynamicSlippageBps) / 10_000) * turnover;
        const turnoverPenalty = notional * (cfg.turnoverPenaltyBps / 10_000) * turnover;
        costs += feeCost + turnoverPenalty;
        state.position = update.action;
        if (state.position !== 0) {
          state.entryPrice = series[i].close;
          state.entryTs = series[i].openTime;
        } else {
          state.entryPrice = 0;
          state.entryTs = 0;
        }
      }

      const next = series[i + 1];
      const priceRet = (next.close - series[i].close) / Math.max(1e-9, series[i].close);
      const notional = equity * (cfg.riskPerTradePct / 100) * Math.max(0.2, Math.abs(state.position));
      const pnl = notional * state.position * priceRet;
      equity += pnl - costs;
      symbolCapital.set(symbol, equity);

      const reward = pnl - costs;
      rewardSeries.push(reward / Math.max(1, equity));
      totalReward += reward;

      const globalEquity = totalEquity(symbolCapital);
      equityCurve.push(globalEquity);
      peak = Math.max(peak, globalEquity);
      const dd = peak <= 0 ? 0 : (peak - globalEquity) / peak;
      maxDrawdown = Math.max(maxDrawdown, dd);
    }

    if (state.position !== 0) {
      const last = series[series.length - 1];
      const closed = closeTrade(state, last, (symbolCapital.get(symbol) ?? 0) * (cfg.riskPerTradePct / 100));
      if (closed) trades.push(closed);
      state.position = 0;
      state.entryPrice = 0;
      state.entryTs = 0;
    }
  }

  const netPnl = totalEquity(symbolCapital) - cfg.initialCapitalUsd;
  const wins = trades.filter(trade => trade.pnlUsd > 0);
  const losses = trades.filter(trade => trade.pnlUsd < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  return {
    netPnl,
    maxDrawdown,
    sharpe: computeSharpe(rewardSeries),
    sortino: computeSortino(rewardSeries),
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    profitFactor: grossLossAbs === 0 ? (grossProfit > 0 ? 50 : 0) : Math.min(50, grossProfit / grossLossAbs),
    trades,
    equityCurve,
    totalReward,
  };
};

const chooseAction = (features: number[], model: RlLinearQPolicyModel, epsilon: number): number => {
  if (Math.random() < epsilon) return Math.floor(Math.random() * 3);
  return greedyActionIndex(features, model);
};

const closeTrade = (state: EpisodeState, candle: Candle, notional: number): RlBacktestTrade | undefined => {
  if (state.position === 0 || state.entryPrice <= 0) return undefined;
  const side: 'long' | 'short' = state.position > 0 ? 'long' : 'short';
  const quantity = notional / Math.max(1e-9, state.entryPrice);
  const pnlUsd = side === 'long'
    ? quantity * (candle.close - state.entryPrice)
    : quantity * (state.entryPrice - candle.close);
  return {
    entryTs: state.entryTs,
    exitTs: candle.closeTime,
    side,
    entryPrice: state.entryPrice,
    exitPrice: candle.close,
    quantity,
    pnlUsd,
  };
};

const groupBySymbol = (candles: Candle[]): Map<string, Candle[]> => {
  const map = new Map<string, Candle[]>();
  for (const candle of candles) {
    if (candle.timeframe !== '1m') continue;
    const list = map.get(candle.symbol) ?? [];
    list.push(candle);
    map.set(candle.symbol, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.openTime - b.openTime);
  }
  return map;
};

const totalEquity = (symbolCapital: Map<string, number>): number => {
  let total = 0;
  for (const value of symbolCapital.values()) total += value;
  return total;
};

const computeSharpe = (returns: number[]): number => {
  if (returns.length < 2) return 0;
  const mean = avg(returns);
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(Math.max(variance, 0));
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
};

const computeSortino = (returns: number[]): number => {
  if (returns.length < 2) return 0;
  const mean = avg(returns);
  const downside = returns.filter(value => value < 0);
  if (downside.length === 0) return 0;
  const downsideVariance = downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length;
  const downsideDev = Math.sqrt(Math.max(0, downsideVariance));
  if (downsideDev === 0) return 0;
  return (mean / downsideDev) * Math.sqrt(252);
};

const avg = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stdDev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
};

const aggregateEpisodeTelemetry = (rows: RlEpisodeTelemetry[]): {
  avgShapedPnlPerStep: number;
  avgCostsPerStep: number;
  avgDdPenaltyPerStep: number;
  avgTurnoverPerStep: number;
  buyShare: number;
  sellShare: number;
  holdShare: number;
} => {
  if (rows.length === 0) {
    return {
      avgShapedPnlPerStep: 0,
      avgCostsPerStep: 0,
      avgDdPenaltyPerStep: 0,
      avgTurnoverPerStep: 0,
      buyShare: 0,
      sellShare: 0,
      holdShare: 1,
    };
  }
  const totals = rows.reduce(
    (acc, row) => {
      acc.steps += row.steps;
      acc.shapedPnl += row.totalShapedPnl;
      acc.costs += row.totalCosts;
      acc.ddPenalty += row.totalDdPenalty;
      acc.turnover += row.totalTurnover;
      acc.buy += row.buyDecisions;
      acc.sell += row.sellDecisions;
      acc.hold += row.holdDecisions;
      return acc;
    },
    { steps: 0, shapedPnl: 0, costs: 0, ddPenalty: 0, turnover: 0, buy: 0, sell: 0, hold: 0 },
  );
  const stepDiv = Math.max(1, totals.steps);
  const decisionDiv = Math.max(1, totals.buy + totals.sell + totals.hold);
  return {
    avgShapedPnlPerStep: totals.shapedPnl / stepDiv,
    avgCostsPerStep: totals.costs / stepDiv,
    avgDdPenaltyPerStep: totals.ddPenalty / stepDiv,
    avgTurnoverPerStep: totals.turnover / stepDiv,
    buyShare: totals.buy / decisionDiv,
    sellShare: totals.sell / decisionDiv,
    holdShare: totals.hold / decisionDiv,
  };
};

const linearSchedule = (start: number, end: number, index: number, maxIndex: number): number => {
  if (maxIndex <= 0) return end;
  const t = Math.min(1, Math.max(0, index / maxIndex));
  return start + (end - start) * t;
};

const isCompatiblePolicy = (model: RlLinearQPolicyModel | undefined): model is RlLinearQPolicyModel => {
  if (!model || model.kind !== 'rl_linear_q') return false;
  if (!Array.isArray(model.featureNames) || model.featureNames.length === 0) return false;
  if (!Array.isArray(model.qWeights) || model.qWeights.length !== 3) return false;
  if (!Array.isArray(model.qBias) || model.qBias.length !== 3) return false;
  const expectedFeatureCount = model.qWeights[0]?.length ?? 0;
  if (expectedFeatureCount === 0) return false;
  if (expectedFeatureCount !== model.featureNames.length) return false;
  return model.qWeights.every(row => Array.isArray(row) && row.length === expectedFeatureCount);
};

const clonePolicy = (model: RlLinearQPolicyModel): RlLinearQPolicyModel => ({
  kind: 'rl_linear_q',
  featureNames: [...model.featureNames],
  qWeights: model.qWeights.map(row => [...row]),
  qBias: [...model.qBias],
  epsilon: model.epsilon,
});

const cloneWeights = (weights: number[][]): number[][] => weights.map(row => [...row]);

const shuffle = <T>(items: T[]): T[] => {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

// Random mini-batch sampling from the replay buffer.
// Fisher-Yates on indices (O(n)) then take first BATCH_SIZE ensures no duplicates.
const sampleBatch = (buffer: ReplayEntry[], batchSize: number): ReplayEntry[] => {
  const n = buffer.length;
  const count = Math.min(batchSize, n);
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).map(idx => buffer[idx]);
};

// Score Q-values using externally provided weights and bias (for target network usage).
const scoreActionsWithWeights = (features: number[], weights: number[][], bias: number[]): number[] => {
  const scores = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    let value = bias[a] ?? 0;
    const wRow = weights[a] ?? [];
    for (let i = 0; i < features.length; i += 1) {
      value += (wRow[i] ?? 0) * features[i];
    }
    scores[a] = value;
  }
  return scores;
};

const pickEpisodeRange = (
  seriesLength: number,
  regimePlan?: RegimeWindowPlan,
  episodeIndex: number = 0,
): [number, number] => {
  if (regimePlan) {
    const order: RegimeName[] = ['trend', 'flat', 'volatile'];
    const preferred = order[episodeIndex % order.length];
    const preferredList = startsByRegime(regimePlan, preferred);
    const allStarts = [...regimePlan.trendStarts, ...regimePlan.flatStarts, ...regimePlan.volatileStarts];
    const pool = preferredList.length > 0 ? preferredList : allStarts;
    if (pool.length > 0) {
      const startIdx = pool[Math.floor(Math.random() * pool.length)];
      const endIdx = Math.max(startIdx + 1, Math.min(seriesLength - 1, startIdx + regimePlan.windowBars));
      return [startIdx, endIdx];
    }
  }

  const minBars = Math.max(120, featureLookback + 16);
  const maxBars = Math.max(minBars, Math.min(seriesLength - 2, Math.floor(seriesLength * 0.35)));
  if (maxBars <= minBars || seriesLength <= minBars + 2) {
    return [featureLookback - 1, Math.max(featureLookback, seriesLength - 1)];
  }
  const windowBars = Math.min(seriesLength - 2, maxBars);
  const earliest = featureLookback - 1;
  const latestStart = Math.max(earliest, seriesLength - windowBars - 1);
  const startIdx = earliest >= latestStart
    ? earliest
    : earliest + Math.floor(Math.random() * (latestStart - earliest + 1));
  const endIdx = Math.max(startIdx + 1, Math.min(seriesLength - 1, startIdx + windowBars));
  return [startIdx, endIdx];
};

const startsByRegime = (plan: RegimeWindowPlan, regime: RegimeName): number[] => {
  if (regime === 'trend') return plan.trendStarts;
  if (regime === 'volatile') return plan.volatileStarts;
  return plan.flatStarts;
};

const buildRegimePlans = (grouped: Map<string, Candle[]>, cfg: RlTrainerOptions): Map<string, RegimeWindowPlan> => {
  const plans = new Map<string, RegimeWindowPlan>();
  for (const [symbol, series] of grouped.entries()) {
    const plan = buildRegimePlan(series, cfg);
    if (plan) plans.set(symbol, plan);
  }
  return plans;
};

const buildRegimePlan = (series: Candle[], cfg: RlTrainerOptions): RegimeWindowPlan | undefined => {
  const lookback = Math.max(24, Math.floor(cfg.regimeLookbackBars));
  const stride = Math.max(1, Math.floor(cfg.regimeStrideBars));
  const windowBars = Math.max(
    120,
    Math.min(
      Math.max(featureLookback + 20, Math.floor(cfg.regimeEpisodeBars)),
      Math.max(120, series.length - featureLookback - 2),
    ),
  );
  if (series.length < lookback + windowBars + featureLookback + 4) return undefined;

  const samples: Array<{ start: number; absRet: number; vol: number }> = [];
  const maxStart = Math.max(featureLookback - 1, series.length - windowBars - 1);
  for (let start = featureLookback - 1; start <= maxStart; start += stride) {
    const metricEnd = start + lookback;
    if (metricEnd >= series.length - 1) break;
    const startPrice = series[start].close;
    const endPrice = series[metricEnd].close;
    const ret = (endPrice - startPrice) / Math.max(1e-9, startPrice);
    const returns: number[] = [];
    for (let i = start + 1; i <= metricEnd; i += 1) {
      const prev = series[i - 1].close;
      const next = series[i].close;
      returns.push((next - prev) / Math.max(1e-9, prev));
    }
    const vol = stdDev(returns);
    samples.push({
      start,
      absRet: Math.abs(ret),
      vol,
    });
  }

  if (samples.length < 12) return undefined;

  const absRets = samples.map(item => item.absRet);
  const vols = samples.map(item => item.vol);
  const trendQ = percentile(absRets, 0.66);
  const volQ = percentile(vols, 0.66);

  const trendStarts: number[] = [];
  const volatileStarts: number[] = [];
  const flatStarts: number[] = [];

  for (const sample of samples) {
    if (sample.vol >= volQ) {
      volatileStarts.push(sample.start);
      continue;
    }
    if (sample.absRet >= trendQ) {
      trendStarts.push(sample.start);
      continue;
    }
    flatStarts.push(sample.start);
  }

  if (trendStarts.length + volatileStarts.length + flatStarts.length < 6) return undefined;

  return {
    trendStarts,
    flatStarts,
    volatileStarts,
    windowBars,
  };
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[pos];
};

const shapePnlReward = (pnlUsd: number): number => {
  if (pnlUsd === 0) return 0;
  const absPnl = Math.abs(pnlUsd);
  if (pnlUsd > 0) {
    for (const band of pnlRewardBands.positive) {
      if (absPnl <= band.maxAbsPnlUsd) return pnlUsd * band.multiplier;
    }
  } else {
    for (const band of pnlRewardBands.negative) {
      if (absPnl <= band.maxAbsPnlUsd) return pnlUsd * band.multiplier;
    }
  }
  return pnlUsd;
};

export const describeAction = (value: -1 | 0 | 1): string => actionIndexToLabel(actionValueToIndex(value));
