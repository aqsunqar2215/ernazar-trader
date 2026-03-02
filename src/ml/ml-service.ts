import { randomUUID } from 'node:crypto';
import { isMainThread, Worker } from 'node:worker_threads';
import type { AppConfig } from '../core/config.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { DatasetBuilder } from './dataset-builder.js';
import { BatchTrainer } from './train.js';
import { ModelRegistry, computeModelScore, type RegisteredModel } from './model-registry.js';
import { BacktestEngine, type BacktestOptions, type BacktestResult } from '../backtest/engine.js';
import { RlTrainer, type RlTrainOutput } from './rl-trainer.js';
import type { RlLinearQPolicyModel } from './rl-policy.js';
import { SupervisedLinearStrategy } from '../strategy/supervised-linear.js';
import type { Candle, Fill, ShadowGateStatus } from '../core/types.js';

interface PaperWindowMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  sharpe?: number;
  maxDrawdownPct: number;
  netPnlUsd: number;
}

interface TemporalSplit {
  train: Candle[];
  holdout: Candle[];
  unseen: Candle[];
  trainEndTs: number;
  holdoutStartTs: number;
  unseenStartTs: number | null;
}

interface SupervisedWalkForwardFold {
  fold: number;
  trainRange: [number, number];
  testRange: [number, number];
  result: BacktestResult;
}

interface SupervisedWalkForwardSummary {
  folds: SupervisedWalkForwardFold[];
  avgSharpe: number;
  avgSortino: number;
  avgProfitFactor: number;
  avgWinRate: number;
  avgNetPnl: number;
  maxDrawdown: number;
}

interface HardNegativeWindow {
  startTs: number;
  endTs: number;
  score: number;
  reason: string;
  createdAt: number;
}

interface ShadowGuardState {
  championId: string;
  activatedAt: number;
}

interface ShadowGateState {
  championId: string;
  activatedAt: number;
}

export class MlService {
  private readonly logger: Logger;
  private readonly registry: ModelRegistry;
  private readonly datasetBuilder = new DatasetBuilder();
  private readonly trainer = new BatchTrainer();
  private readonly rlTrainer = new RlTrainer();
  private timer?: NodeJS.Timeout;
  private lastSupervisedRetrainAt = 0;
  private lastSupervisedTrainEndTs = 0;
  private lastRlRetrainAt = 0;
  private consecutiveRlNotPromoted = 0;
  private rlCooldownUntilPaperTrades = 0;
  private rlHardNegativeWindows: HardNegativeWindow[] = [];
  private shadowGuardState?: ShadowGuardState;
  private shadowGateState?: ShadowGateState;
  private retrainWorker?: Worker;
  private retrainWorkerSeq = 0;
  private retrainWorkerPending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private retrainInFlight?: Promise<Record<string, unknown>>;

  constructor(
    private readonly db: StateDb,
    logger: Logger,
    private readonly config: AppConfig,
  ) {
    this.logger = logger.child('ml');
    this.registry = new ModelRegistry(config.ml.registryPath);
  }

  start(getPaperMetrics: () => PaperWindowMetrics): void {
    const intervalMs = Math.max(1, this.config.ml.retrainIntervalHours) * 60 * 60 * 1_000;
    this.timer = setInterval(() => {
      void this.retrain(getPaperMetrics());
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retrainWorker) {
      this.retrainWorker.terminate();
      this.retrainWorker = undefined;
    }
    this.retrainWorkerPending.clear();
    this.retrainInFlight = undefined;
  }

  private refreshRegistry(): void {
    this.registry.reload();
  }

  getRegistrySnapshot(): { champion?: RegisteredModel; challengers: RegisteredModel[] } {
    this.refreshRegistry();
    return {
      champion: this.registry.getChampion(),
      challengers: this.registry.getChallengers(),
    };
  }

  getCheckpointList(limit: number = 100): {
    total: number;
    count: number;
    checkpoints: Array<Record<string, unknown>>;
  } {
    this.refreshRegistry();
    const cap = Math.min(500, Math.max(1, Math.floor(limit || 100)));
    const champion = this.registry.getChampion();
    const challengers = this.registry.getChallengers();
    const all = [...(champion ? [champion] : []), ...challengers].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
    const checkpoints = all.slice(0, cap).map(model => {
      const warmStartModelId = typeof model.training?.warmStartModelId === 'string'
        ? model.training.warmStartModelId
        : null;
      return {
        id: model.id,
        stage: model.stage,
        kind: model.kind ?? 'supervised_linear',
        source: model.source,
        createdAt: model.createdAt,
        createdAtIso: new Date(model.createdAt).toISOString(),
        warmStartModelId,
        metrics: model.metrics,
        evaluation: model.evaluation,
      };
    });
    return {
      total: all.length,
      count: checkpoints.length,
      checkpoints,
    };
  }

  getBestRlModel(): RegisteredModel | undefined {
    this.refreshRegistry();
    const champion = this.registry.getChampion();
    if (champion && champion.kind === 'rl_linear_q') return champion;
    const rlChallengers = this.registry
      .getChallengers()
      .filter(item => item.kind === 'rl_linear_q');
    if (rlChallengers.length === 0) return undefined;
    rlChallengers.sort((a, b) => computeModelScore(b.evaluation) - computeModelScore(a.evaluation));
    return rlChallengers[0];
  }

  getChampionRlModel(): RegisteredModel | undefined {
    this.refreshRegistry();
    const champion = this.registry.getChampion();
    if (!champion || champion.kind !== 'rl_linear_q') return undefined;
    return champion;
  }

  async retrain(paperWindow: PaperWindowMetrics): Promise<Record<string, unknown>> {
    if (!isMainThread) {
      return this.retrainLocal(paperWindow);
    }
    if (this.retrainInFlight) return this.retrainInFlight;
    this.retrainInFlight = this.retrainOnWorker(paperWindow)
      .then(result => {
        this.refreshRegistry();
        return result;
      })
      .finally(() => {
        this.retrainInFlight = undefined;
      });
    return this.retrainInFlight;
  }

  private async retrainLocal(paperWindow: PaperWindowMetrics): Promise<Record<string, unknown>> {
    const pretrainBarsTarget = Math.max(0, Math.floor(this.config.ml.pretrainMonths * 30 * 24 * 60));
    const unseenBarsTarget = this.config.ml.unseenGateEnabled ? Math.max(0, Math.floor(this.config.ml.unseenBars)) : 0;
    const requestedLimit = Math.max(2_000, Math.floor(this.config.ml.retrainCandlesLimit));
    const desiredLimit = Math.min(400_000, pretrainBarsTarget + unseenBarsTarget + 8_000);
    const candlesLimit = Math.max(2_000, Math.min(requestedLimit, desiredLimit));
    const fillsLimit = Math.max(500, Math.floor(this.config.ml.retrainFillsLimit));
    const candles = this.db
      .getRecentCandles(candlesLimit)
      .filter(item => item.timeframe === '1m' && item.source !== 'gap_fill');
    const fills = this.db.getFills(fillsLimit);
    const result: Record<string, unknown> = {
      mode: 'offline_batch',
      paperWindow,
      supervised: {
        attempted: false,
        promoted: false,
      },
      rl: {
        attempted: false,
        promoted: false,
      },
    };

    const oosPrefilter = this.checkOosPrefilter(candles);
    if (!oosPrefilter.passed) {
      return {
        ...result,
        oosPrefilter,
        supervised: {
          attempted: false,
          promoted: false,
          reason: oosPrefilter.reason,
        },
        rl: {
          attempted: false,
          promoted: false,
          reason: oosPrefilter.reason,
        },
      };
    }

    const supervisedResult = this.retrainSupervised(candles, fills, paperWindow);
    result.supervised = supervisedResult;

    const rlResult = this.retrainRl(candles, paperWindow);
    result.rl = rlResult;

    return result;
  }

  private ensureRetrainWorker(): Worker {
    if (this.retrainWorker) return this.retrainWorker;
    const worker = new Worker(new URL('./retrain-worker.js', import.meta.url), { type: 'module' } as any);
    worker.on('message', (message: { id: number; ok: boolean; result?: Record<string, unknown>; error?: string }) => {
      const pending = this.retrainWorkerPending.get(message.id);
      if (!pending) return;
      this.retrainWorkerPending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result ?? {});
      } else {
        pending.reject(new Error(message.error ?? 'retrain worker failed'));
      }
    });
    worker.on('error', error => {
      for (const pending of this.retrainWorkerPending.values()) {
        pending.reject(error);
      }
      this.retrainWorkerPending.clear();
    });
    worker.on('exit', code => {
      if (code !== 0) {
        const error = new Error(`retrain worker exited with code ${code}`);
        for (const pending of this.retrainWorkerPending.values()) {
          pending.reject(error);
        }
        this.retrainWorkerPending.clear();
      }
      if (this.retrainWorker === worker) {
        this.retrainWorker = undefined;
      }
    });
    this.retrainWorker = worker;
    return worker;
  }

  private retrainOnWorker(paperWindow: PaperWindowMetrics): Promise<Record<string, unknown>> {
    const worker = this.ensureRetrainWorker();
    const id = (this.retrainWorkerSeq += 1);
    return new Promise((resolve, reject) => {
      this.retrainWorkerPending.set(id, { resolve, reject });
      worker.postMessage({ type: 'retrain', id, paperWindow });
    });
  }

  private retrainSupervised(candles: ReturnType<StateDb['getRecentCandles']>, fills: ReturnType<StateDb['getFills']>, paperWindow: PaperWindowMetrics): Record<string, unknown> {
    const now = Date.now();
    const minIntervalMs = Math.max(0, this.config.ml.minRetrainIntervalMinutes) * 60_000;
    if (this.lastSupervisedRetrainAt > 0 && now - this.lastSupervisedRetrainAt < minIntervalMs) {
      const waitMs = minIntervalMs - (now - this.lastSupervisedRetrainAt);
      return {
        attempted: false,
        promoted: false,
        reason: `supervised retrain throttled by min interval (${Math.ceil(waitMs / 1000)}s left)`,
      };
    }

    const split = this.splitTemporalWithUnseen(candles, this.config.ml.holdoutRatio, this.config.ml.purgeBars, 260, 120);
    if (!split) {
      return {
        attempted: false,
        promoted: false,
        reason: 'not enough candles after temporal split/purge for supervised retraining',
        candles: candles.length,
        holdoutRatio: this.config.ml.holdoutRatio,
        purgeBars: this.config.ml.purgeBars,
      };
    }
    if (split.trainEndTs <= this.lastSupervisedTrainEndTs) {
      return {
        attempted: false,
        promoted: false,
        reason: 'supervised retrain skipped: no new train candles',
        trainEndTs: split.trainEndTs,
        lastSupervisedTrainEndTs: this.lastSupervisedTrainEndTs,
      };
    }

    const trainFills = this.filterFillsByTimestamp(fills, split.trainEndTs);
    const dataset = this.datasetBuilder.build(split.train, trainFills);
    if (dataset.length < 200) {
      return {
        attempted: false,
        promoted: false,
        reason: 'not enough dataset samples for retraining',
        datasetSize: dataset.length,
      };
    }

    const model = this.trainer.train(dataset);
    const backtestOptions = this.buildBacktestOptions();
    const wf = this.evaluateSupervisedWalkForward(
      split.train,
      trainFills,
      backtestOptions,
      Math.max(1, Math.floor(this.config.ml.supervisedWfFolds)),
      this.config.ml.purgeBars,
    );
    const holdoutBacktest = new BacktestEngine(() => new SupervisedLinearStrategy(model));
    const holdout = holdoutBacktest.run(split.holdout, backtestOptions);
    const gatePaper = this.toPaperMetricsFromBacktest(holdout);
    const unseen = split.unseen.length > 0
      ? holdoutBacktest.run(split.unseen, backtestOptions)
      : {
          netPnl: 0,
          maxDrawdown: 0,
          sharpe: 0,
          sortino: 0,
          winRate: 0,
          profitFactor: 0,
          trades: [],
          equityCurve: [backtestOptions.initialCapitalUsd],
        };
    const gateUnseen = this.toPaperMetricsFromBacktest(unseen as BacktestResult);

    const challenger: RegisteredModel = {
      ...model,
      id: randomUUID(),
      stage: 'challenger',
      source: 'batch_training',
      evaluation: {
        walkForwardSharpe: wf.avgSharpe,
        walkForwardProfitFactor: wf.avgProfitFactor,
        walkForwardMaxDrawdown: wf.maxDrawdown,
        paperWindowProfitFactor: gatePaper.profitFactor,
        paperWindowSharpe: gatePaper.sharpe,
        paperWindowNetPnl: gatePaper.netPnlUsd,
        paperWindowTrades: gatePaper.trades,
        unseenProfitFactor: gateUnseen.profitFactor,
        unseenSharpe: gateUnseen.sharpe,
        unseenNetPnl: gateUnseen.netPnlUsd,
        unseenTrades: gateUnseen.trades,
      },
    };

    this.registry.registerChallenger(challenger);
    const promotion = this.registry.evaluatePromotion({
      challengerId: challenger.id,
      simplePromotionEnabled: this.config.ml.simplePromotionEnabled,
      simplePromotionAllowRl: this.config.ml.simplePromotionAllowRl,
      simplePromotionMinWinRate: this.config.ml.simplePromotionMinWinRate,
      simplePromotionMinNetPnl: this.config.ml.simplePromotionMinNetPnl,
      minWalkForwardSharpe: this.config.ml.minWalkForwardSharpe,
      minWalkForwardProfitFactor: this.config.ml.minWalkForwardProfitFactor,
      maxWalkForwardDrawdown: this.config.ml.maxWalkForwardDrawdown,
      minPaperProfitFactor: this.config.ml.minPaperProfitFactor,
      minPaperSharpe: this.config.ml.minPaperSharpe,
      minPaperTrades: this.config.ml.minPaperTrades,
      enforceUnseenGate: this.config.ml.unseenGateEnabled,
      minUnseenProfitFactor: this.config.ml.unseenMinProfitFactor,
      minUnseenSharpe: this.config.ml.unseenMinSharpe,
      minUnseenTrades: this.config.ml.unseenMinTrades,
    });
    if (promotion.promoted) {
      this.auditPromotion(challenger.id, promotion.reason, wf.avgSharpe, gatePaper.profitFactor);
    }
    this.lastSupervisedRetrainAt = Date.now();
    this.lastSupervisedTrainEndTs = split.trainEndTs;

    this.logger.info('supervised retrain completed', {
      challengerId: challenger.id,
      datasetSize: dataset.length,
      promoted: promotion.promoted,
      reason: promotion.reason,
      splitTrainCandles: split.train.length,
      splitHoldoutCandles: split.holdout.length,
      wfSharpe: wf.avgSharpe,
      wfProfitFactor: wf.avgProfitFactor,
      wfMaxDrawdown: wf.maxDrawdown,
      holdoutSharpe: holdout.sharpe,
      holdoutProfitFactor: holdout.profitFactor,
      holdoutTrades: holdout.trades.length,
      gatePaperProfitFactor: gatePaper.profitFactor,
      gatePaperSharpe: gatePaper.sharpe,
      gatePaperTrades: gatePaper.trades,
      unseenSharpe: unseen.sharpe,
      unseenProfitFactor: unseen.profitFactor,
      unseenTrades: unseen.trades.length,
      runtimePaperProfitFactor: paperWindow.profitFactor,
      runtimePaperTrades: paperWindow.trades,
      gateMinPaperTrades: this.config.ml.minPaperTrades,
      gateMinPaperSharpe: this.config.ml.minPaperSharpe,
      gateMinUnseenTrades: this.config.ml.unseenMinTrades,
      gateMinUnseenSharpe: this.config.ml.unseenMinSharpe,
    });

    return {
      attempted: true,
      challengerId: challenger.id,
      promoted: promotion.promoted,
      reason: promotion.reason,
      datasetSize: dataset.length,
      temporalSplit: {
        trainCandles: split.train.length,
        holdoutCandles: split.holdout.length,
        holdoutStartTs: split.holdoutStartTs,
      },
      learningHealth: {
        trainAccuracy: model.metrics.accuracy,
        trainF1: model.metrics.f1,
        trainPrecision: model.metrics.precision,
        trainRecall: model.metrics.recall,
      },
      walkForward: {
        sharpe: wf.avgSharpe,
        profitFactor: wf.avgProfitFactor,
        maxDrawdown: wf.maxDrawdown,
      },
      holdout: {
        sharpe: holdout.sharpe,
        profitFactor: holdout.profitFactor,
        maxDrawdown: holdout.maxDrawdown,
        trades: holdout.trades.length,
        netPnl: holdout.netPnl,
      },
      unseen: {
        sharpe: unseen.sharpe,
        profitFactor: unseen.profitFactor,
        maxDrawdown: unseen.maxDrawdown,
        trades: unseen.trades.length,
        netPnl: unseen.netPnl,
      },
      promotionReadiness: {
        walkForwardSharpe: wf.avgSharpe,
        walkForwardProfitFactor: wf.avgProfitFactor,
        walkForwardMaxDrawdown: wf.maxDrawdown,
        paperWindowProfitFactor: gatePaper.profitFactor,
        paperWindowSharpe: gatePaper.sharpe,
        paperWindowTrades: gatePaper.trades,
        unseenProfitFactor: gateUnseen.profitFactor,
        unseenSharpe: gateUnseen.sharpe,
        unseenTrades: gateUnseen.trades,
      },
      scorecard: {
        modelKind: 'supervised_linear',
        promoted: promotion.promoted,
        reason: promotion.reason,
        thresholds: this.buildPromotionThresholds(),
        split: {
          trainCandles: split.train.length,
          holdoutCandles: split.holdout.length,
          unseenCandles: split.unseen.length,
          trainEndTs: split.trainEndTs,
          holdoutStartTs: split.holdoutStartTs,
          unseenStartTs: split.unseenStartTs,
        },
        metrics: {
          inSample: null,
          walkForward: {
            sharpe: wf.avgSharpe,
            profitFactor: wf.avgProfitFactor,
            maxDrawdown: wf.maxDrawdown,
          },
          holdout: {
            sharpe: holdout.sharpe,
            profitFactor: holdout.profitFactor,
            trades: holdout.trades.length,
            netPnl: holdout.netPnl,
          },
          unseen: {
            sharpe: unseen.sharpe,
            profitFactor: unseen.profitFactor,
            trades: unseen.trades.length,
            netPnl: unseen.netPnl,
          },
        },
      },
    };
  }

  private retrainRl(candles: ReturnType<StateDb['getRecentCandles']>, paperWindow: PaperWindowMetrics): Record<string, unknown> {
    if (!this.config.rl.enabled) {
      return {
        attempted: false,
        promoted: false,
        reason: 'rl disabled by config',
      };
    }
    const pacingBlock = this.getRlRetrainBlocker(paperWindow);
    if (pacingBlock) {
      return {
        attempted: false,
        promoted: false,
        reason: pacingBlock,
        pacing: {
          lastRetrainAt: this.lastRlRetrainAt || null,
          consecutiveNonPromoted: this.consecutiveRlNotPromoted,
          cooldownUntilPaperTrades: this.rlCooldownUntilPaperTrades,
          currentPaperTrades: paperWindow.trades,
        },
      };
    }
    if (candles.length < 600) {
      return {
        attempted: false,
        promoted: false,
        reason: 'not enough candles for rl training',
        candles: candles.length,
      };
    }

    const split = this.splitTemporalWithUnseen(candles, this.config.ml.holdoutRatio, this.config.ml.purgeBars, 300, 140);
    if (!split) {
      return {
        attempted: false,
        promoted: false,
        reason: 'not enough candles after temporal split/purge for rl retraining',
        candles: candles.length,
        holdoutRatio: this.config.ml.holdoutRatio,
        purgeBars: this.config.ml.purgeBars,
      };
    }

    const warmStartModel = this.pickRlWarmStartCheckpoint();
    const warmStartPolicy = this.asRlPolicy(warmStartModel);
    const simOptions = {
      initialCapitalUsd: this.config.execution.initialEquityUsd,
      feeBps: this.config.execution.feeBps,
      slippageBps: this.config.execution.slippageBps,
      latencyBars: this.config.rl.latencyBars,
      riskPerTradePct: this.config.risk.maxRiskPerTradePct,
      turnoverPenaltyBps: this.config.rl.turnoverPenaltyBps,
      drawdownPenaltyFactor: this.config.rl.drawdownPenaltyFactor,
      confidenceGateEnabled: this.config.rl.confidenceGateEnabled,
      confidenceQGap: this.config.rl.confidenceQGap,
      minHoldBars: this.config.rl.minHoldBars,
      flipCooldownBars: this.config.rl.flipCooldownBars,
      regimeSplitEnabled: this.config.rl.regimeSplitEnabled,
    };
    const rlTrainOptions = {
      episodes: this.config.rl.episodes,
      minEpisodes: this.config.rl.minEpisodes,
      earlyStopPatience: this.config.rl.earlyStopPatience,
      earlyStopMinDelta: this.config.rl.earlyStopMinDelta,
      learningRate: this.config.rl.learningRate,
      gamma: this.config.rl.gamma,
      epsilonStart: this.config.rl.epsilonStart,
      epsilonEnd: this.config.rl.epsilonEnd,
      feeBps: this.config.execution.feeBps,
      slippageBps: this.config.execution.slippageBps,
      latencyBars: this.config.rl.latencyBars,
      riskPerTradePct: this.config.risk.maxRiskPerTradePct,
      turnoverPenaltyBps: this.config.rl.turnoverPenaltyBps,
      drawdownPenaltyFactor: this.config.rl.drawdownPenaltyFactor,
      rewardCostWeight: this.config.rl.rewardCostWeight,
      rewardHoldPenalty: this.config.rl.rewardHoldPenalty,
      rewardActionBonus: this.config.rl.rewardActionBonus,
      confidenceGateEnabled: this.config.rl.confidenceGateEnabled,
      confidenceQGap: this.config.rl.confidenceQGap,
      minHoldBars: this.config.rl.minHoldBars,
      flipCooldownBars: this.config.rl.flipCooldownBars,
      regimeSplitEnabled: this.config.rl.regimeSplitEnabled,
      regimeBalanced: this.config.rl.regimeBalanced,
      regimeLookbackBars: this.config.rl.regimeLookbackBars,
      regimeEpisodeBars: this.config.rl.regimeEpisodeBars,
      regimeStrideBars: this.config.rl.regimeStrideBars,
    };
    let trainingSeedPolicy = warmStartPolicy;
    let pretrain: RlTrainOutput | null = null;
    let pretrainWf: ReturnType<RlTrainer['walkForward']> | null = null;
    const pretrainCandles = this.pickPretrainCandles(split.train);
    if (pretrainCandles.length >= Math.max(600, this.config.ml.pretrainMinCandles)) {
      const pretrainOptions = {
        ...rlTrainOptions,
        episodes: this.config.rl.pretrainEpisodes,
        minEpisodes: Math.min(this.config.rl.pretrainEpisodes, this.config.rl.pretrainMinEpisodes),
      };
      pretrain = this.rlTrainer.train(pretrainCandles, pretrainOptions, trainingSeedPolicy);
      pretrainWf = this.rlTrainer.walkForwardRetrainWarmStart(
        pretrainCandles,
        pretrain.model,
        simOptions,
        Math.max(1, Math.floor(this.config.ml.pretrainWfFolds)),
        pretrainOptions,
        this.config.ml.purgeBars,
      );
      trainingSeedPolicy = pretrain.model;
    }

    let replay: RlTrainOutput | null = null;
    const replayCandles = this.buildHardNegativeReplayCandles(candles);
    if (this.config.rl.hardNegativeReplayEnabled && replayCandles.length >= 600) {
      const replayOptions = {
        ...rlTrainOptions,
        episodes: this.config.rl.hardNegativeReplayEpisodes,
        minEpisodes: Math.min(this.config.rl.hardNegativeReplayEpisodes, this.config.rl.hardNegativeReplayMinEpisodes),
      };
      replay = this.rlTrainer.train(replayCandles, replayOptions, trainingSeedPolicy);
      trainingSeedPolicy = replay.model;
    }

    const ensembleEnabled = this.config.rl.ensembleEnabled && this.config.rl.ensembleSize > 1;
    const ensembleSize = Math.max(1, Math.floor(this.config.rl.ensembleSize));
    let rlOutput: RlTrainOutput;
    let holdout: ReturnType<RlTrainer['evaluate']>;
    let gatePaper: PaperWindowMetrics;
    let unseen: ReturnType<RlTrainer['evaluate']>;
    let gateUnseen: PaperWindowMetrics;
    let ensembleSummary: Record<string, unknown> | null = null;

    if (ensembleEnabled) {
      const runs: Array<{
        output: RlTrainOutput;
        holdout: ReturnType<RlTrainer['evaluate']>;
        gatePaper: PaperWindowMetrics;
        unseen: ReturnType<RlTrainer['evaluate']>;
        gateUnseen: PaperWindowMetrics;
        oosScore: number;
      }> = [];
      for (let idx = 0; idx < ensembleSize; idx += 1) {
        const output = this.rlTrainer.train(split.train, rlTrainOptions, trainingSeedPolicy);
        const holdoutResult = this.rlTrainer.evaluate(split.holdout, output.model, simOptions);
        const holdoutPaper = this.toPaperMetricsFromRl(holdoutResult);
        const unseenResult = split.unseen.length > 0
          ? this.rlTrainer.evaluate(split.unseen, output.model, simOptions)
          : this.rlTrainer.evaluate([], output.model, simOptions);
        const unseenPaper = this.toPaperMetricsFromRl(unseenResult);
        const oosScore = Number.isFinite(holdoutPaper.profitFactor) ? holdoutPaper.profitFactor : Number.NEGATIVE_INFINITY;
        runs.push({ output, holdout: holdoutResult, gatePaper: holdoutPaper, unseen: unseenResult, gateUnseen: unseenPaper, oosScore });
      }

      const scores = runs.map(run => run.oosScore).filter(score => Number.isFinite(score));
      const sortedScores = [...scores].sort((a, b) => a - b);
      const medianScore = sortedScores.length > 0 ? sortedScores[Math.floor(sortedScores.length / 2)] : Number.NEGATIVE_INFINITY;
      let chosen = runs[0];
      let bestDistance = Math.abs(chosen.oosScore - medianScore);
      for (const run of runs) {
        const distance = Math.abs(run.oosScore - medianScore);
        if (distance < bestDistance) {
          chosen = run;
          bestDistance = distance;
        }
      }

      rlOutput = chosen.output;
      holdout = chosen.holdout;
      gatePaper = chosen.gatePaper;
      unseen = chosen.unseen;
      gateUnseen = chosen.gateUnseen;
      ensembleSummary = {
        enabled: true,
        size: ensembleSize,
        medianOosProfitFactor: Number.isFinite(medianScore) ? medianScore : null,
        selectedOosProfitFactor: Number.isFinite(chosen.oosScore) ? chosen.oosScore : null,
        scores: runs.map(run => run.oosScore),
      };
    } else {
      rlOutput = this.rlTrainer.train(split.train, rlTrainOptions, trainingSeedPolicy);
      holdout = this.rlTrainer.evaluate(split.holdout, rlOutput.model, simOptions);
      gatePaper = this.toPaperMetricsFromRl(holdout);
      unseen = split.unseen.length > 0 ? this.rlTrainer.evaluate(split.unseen, rlOutput.model, simOptions) : this.rlTrainer.evaluate([], rlOutput.model, simOptions);
      gateUnseen = this.toPaperMetricsFromRl(unseen);
    }

    const wf = this.rlTrainer.walkForwardFixed(
      split.train,
      rlOutput.model,
      simOptions,
      Math.max(1, Math.floor(this.config.ml.rlWfFolds)),
      this.config.ml.purgeBars,
    );

    const challenger: RegisteredModel = {
      id: randomUUID(),
      createdAt: Date.now(),
      stage: 'challenger',
      source: 'rl_offline_q_learning',
      featureNames: rlOutput.model.featureNames,
      weights: rlOutput.model.qWeights.flat(),
      bias: 0,
      kind: 'rl_linear_q',
      qWeights: rlOutput.model.qWeights,
      qBias: rlOutput.model.qBias,
      regimeHeads: this.cloneRegimeHeads(rlOutput.model.regimeHeads),
      training: {
        episodes: rlOutput.training.episodes,
        avgEpisodeReward: rlOutput.training.avgEpisodeReward,
        warmStartModelId: warmStartModel?.id ?? 'none',
        pretrainEpisodes: pretrain?.training.episodes ?? 0,
        replayEpisodes: replay?.training.episodes ?? 0,
      },
      metrics: {
        accuracy: rlOutput.inSample.winRate,
        f1: rlOutput.inSample.profitFactor,
        precision: Math.max(0, 1 - rlOutput.inSample.maxDrawdown),
        recall: rlOutput.inSample.sharpe,
      },
      evaluation: {
        walkForwardSharpe: wf.avgSharpe,
        walkForwardProfitFactor: wf.avgProfitFactor,
        walkForwardMaxDrawdown: wf.maxDrawdown,
        paperWindowProfitFactor: gatePaper.profitFactor,
        paperWindowSharpe: gatePaper.sharpe,
        paperWindowNetPnl: gatePaper.netPnlUsd,
        paperWindowTrades: gatePaper.trades,
        unseenProfitFactor: gateUnseen.profitFactor,
        unseenSharpe: gateUnseen.sharpe,
        unseenNetPnl: gateUnseen.netPnlUsd,
        unseenTrades: gateUnseen.trades,
        inSampleWinRate: rlOutput.inSample.winRate,
        inSampleNetPnl: rlOutput.inSample.netPnl,
      },
    };

    this.registry.registerChallenger(challenger);
    const ensembleGate = this.evaluateEnsembleGate(ensembleSummary);
    const promotion = ensembleGate.passed
      ? this.registry.evaluatePromotion({
      challengerId: challenger.id,
      simplePromotionEnabled: this.config.ml.simplePromotionEnabled,
      simplePromotionAllowRl: this.config.ml.simplePromotionAllowRl,
      simplePromotionMinWinRate: this.config.ml.simplePromotionMinWinRate,
      simplePromotionMinNetPnl: this.config.ml.simplePromotionMinNetPnl,
      minWalkForwardSharpe: this.config.ml.minWalkForwardSharpe,
      minWalkForwardProfitFactor: this.config.ml.minWalkForwardProfitFactor,
      maxWalkForwardDrawdown: this.config.ml.maxWalkForwardDrawdown,
      minPaperProfitFactor: this.config.ml.minPaperProfitFactor,
      minPaperSharpe: this.config.ml.minPaperSharpe,
      minPaperTrades: this.config.ml.minPaperTrades,
      enforceUnseenGate: this.config.ml.unseenGateEnabled,
      minUnseenProfitFactor: this.config.ml.unseenMinProfitFactor,
      minUnseenSharpe: this.config.ml.unseenMinSharpe,
      minUnseenTrades: this.config.ml.unseenMinTrades,
    })
      : { promoted: false, reason: ensembleGate.reason };
    if (promotion.promoted) {
      this.auditPromotion(challenger.id, promotion.reason, wf.avgSharpe, gatePaper.profitFactor);
      this.consecutiveRlNotPromoted = 0;
      this.rlCooldownUntilPaperTrades = 0;
      this.shadowGuardState = {
        championId: challenger.id,
        activatedAt: Date.now(),
      };
    } else {
      this.consecutiveRlNotPromoted += 1;
      if (
        !this.config.rl.disablePacing &&
        this.config.rl.maxConsecutiveNonPromoted > 0 &&
        this.consecutiveRlNotPromoted >= this.config.rl.maxConsecutiveNonPromoted
      ) {
        const cooldownTrades = Math.max(0, Math.floor(this.config.rl.cooldownTradesAfterStop));
        this.rlCooldownUntilPaperTrades = paperWindow.trades + cooldownTrades;
        this.consecutiveRlNotPromoted = 0;
      }
    }
    this.rememberHardNegativeWindows(wf, split, holdout);
    this.lastRlRetrainAt = Date.now();

    this.logger.info('rl retrain completed', {
      challengerId: challenger.id,
      promoted: promotion.promoted,
      reason: promotion.reason,
      ensemble: ensembleSummary,
      ensembleGate,
      episodesRequested: this.config.rl.episodes,
      episodesRan: rlOutput.training.episodes,
      avgEpisodeReward: rlOutput.training.avgEpisodeReward,
      avgCostsPerStep: rlOutput.training.avgCostsPerStep,
      avgDdPenaltyPerStep: rlOutput.training.avgDdPenaltyPerStep,
      avgShapedPnlPerStep: rlOutput.training.avgShapedPnlPerStep,
      buyShare: rlOutput.training.buyShare,
      sellShare: rlOutput.training.sellShare,
      holdShare: rlOutput.training.holdShare,
      splitTrainCandles: split.train.length,
      splitHoldoutCandles: split.holdout.length,
      inSampleWinRate: rlOutput.inSample.winRate,
      inSampleNetPnl: rlOutput.inSample.netPnl,
      inSampleSharpe: rlOutput.inSample.sharpe,
      inSampleProfitFactor: rlOutput.inSample.profitFactor,
      wfSharpe: wf.avgSharpe,
      wfProfitFactor: wf.avgProfitFactor,
      wfMaxDrawdown: wf.maxDrawdown,
      holdoutSharpe: holdout.sharpe,
      holdoutProfitFactor: holdout.profitFactor,
      holdoutTrades: holdout.trades.length,
      unseenSharpe: unseen.sharpe,
      unseenProfitFactor: unseen.profitFactor,
      unseenTrades: unseen.trades.length,
      gatePaperProfitFactor: gatePaper.profitFactor,
      gatePaperSharpe: gatePaper.sharpe,
      gatePaperTrades: gatePaper.trades,
      gateUnseenProfitFactor: gateUnseen.profitFactor,
      gateUnseenSharpe: gateUnseen.sharpe,
      gateUnseenTrades: gateUnseen.trades,
      runtimePaperProfitFactor: paperWindow.profitFactor,
      runtimePaperTrades: paperWindow.trades,
      gateMinPaperTrades: this.config.ml.minPaperTrades,
      gateMinPaperSharpe: this.config.ml.minPaperSharpe,
      gateMinUnseenTrades: this.config.ml.unseenMinTrades,
      gateMinUnseenSharpe: this.config.ml.unseenMinSharpe,
      warmStartModelId: warmStartModel?.id ?? null,
      pretrainEpisodes: pretrain?.training.episodes ?? 0,
      pretrainWfProfitFactor: pretrainWf?.avgProfitFactor ?? 0,
      replayEpisodes: replay?.training.episodes ?? 0,
      replayCandles: replayCandles.length,
      hardNegativeWindowCount: this.rlHardNegativeWindows.length,
      nextRlCooldownUntilPaperTrades: this.rlCooldownUntilPaperTrades,
    });

    return {
      attempted: true,
      challengerId: challenger.id,
      promoted: promotion.promoted,
      reason: promotion.reason,
      ensemble: ensembleSummary,
      ensembleGate,
      temporalSplit: {
        trainCandles: split.train.length,
        holdoutCandles: split.holdout.length,
        holdoutStartTs: split.holdoutStartTs,
        unseenCandles: split.unseen.length,
        unseenStartTs: split.unseenStartTs,
      },
      pretrain: pretrain
        ? {
            candles: pretrainCandles.length,
            episodes: pretrain.training.episodes,
            avgEpisodeReward: pretrain.training.avgEpisodeReward,
            wfSharpe: pretrainWf?.avgSharpe ?? 0,
            wfProfitFactor: pretrainWf?.avgProfitFactor ?? 0,
          }
        : null,
      replay: replay
        ? {
            candles: replayCandles.length,
            episodes: replay.training.episodes,
            avgEpisodeReward: replay.training.avgEpisodeReward,
          }
        : null,
      training: rlOutput.training,
      learningHealth: {
        avgEpisodeReward: rlOutput.training.avgEpisodeReward,
        avgShapedPnlPerStep: rlOutput.training.avgShapedPnlPerStep,
        avgCostsPerStep: rlOutput.training.avgCostsPerStep,
        avgDdPenaltyPerStep: rlOutput.training.avgDdPenaltyPerStep,
        avgTurnoverPerStep: rlOutput.training.avgTurnoverPerStep,
        buyShare: rlOutput.training.buyShare,
        sellShare: rlOutput.training.sellShare,
        holdShare: rlOutput.training.holdShare,
      },
      inSample: {
        winRate: rlOutput.inSample.winRate,
        netPnl: rlOutput.inSample.netPnl,
        sharpe: rlOutput.inSample.sharpe,
        profitFactor: rlOutput.inSample.profitFactor,
        maxDrawdown: rlOutput.inSample.maxDrawdown,
      },
      walkForward: {
        sharpe: wf.avgSharpe,
        profitFactor: wf.avgProfitFactor,
        maxDrawdown: wf.maxDrawdown,
      },
      holdout: {
        sharpe: holdout.sharpe,
        profitFactor: holdout.profitFactor,
        maxDrawdown: holdout.maxDrawdown,
        trades: holdout.trades.length,
        netPnl: holdout.netPnl,
      },
      unseen: {
        sharpe: unseen.sharpe,
        profitFactor: unseen.profitFactor,
        maxDrawdown: unseen.maxDrawdown,
        trades: unseen.trades.length,
        netPnl: unseen.netPnl,
      },
      promotionReadiness: {
        walkForwardSharpe: wf.avgSharpe,
        walkForwardProfitFactor: wf.avgProfitFactor,
        walkForwardMaxDrawdown: wf.maxDrawdown,
        paperWindowProfitFactor: gatePaper.profitFactor,
        paperWindowSharpe: gatePaper.sharpe,
        paperWindowTrades: gatePaper.trades,
        unseenProfitFactor: gateUnseen.profitFactor,
        unseenSharpe: gateUnseen.sharpe,
        unseenTrades: gateUnseen.trades,
      },
      scorecard: {
        modelKind: 'rl_linear_q',
        promoted: promotion.promoted,
        reason: promotion.reason,
        thresholds: this.buildPromotionThresholds(),
        split: {
          trainCandles: split.train.length,
          holdoutCandles: split.holdout.length,
          unseenCandles: split.unseen.length,
          trainEndTs: split.trainEndTs,
          holdoutStartTs: split.holdoutStartTs,
          unseenStartTs: split.unseenStartTs,
        },
        metrics: {
          inSample: {
            winRate: rlOutput.inSample.winRate,
            netPnl: rlOutput.inSample.netPnl,
            sharpe: rlOutput.inSample.sharpe,
            profitFactor: rlOutput.inSample.profitFactor,
            maxDrawdown: rlOutput.inSample.maxDrawdown,
          },
          walkForward: {
            sharpe: wf.avgSharpe,
            profitFactor: wf.avgProfitFactor,
            maxDrawdown: wf.maxDrawdown,
          },
          holdout: {
            sharpe: holdout.sharpe,
            profitFactor: holdout.profitFactor,
            trades: holdout.trades.length,
            netPnl: holdout.netPnl,
          },
          unseen: {
            sharpe: unseen.sharpe,
            profitFactor: unseen.profitFactor,
            trades: unseen.trades.length,
            netPnl: unseen.netPnl,
          },
        },
      },
      warmStartModelId: warmStartModel?.id ?? null,
      pacing: {
        minRetrainIntervalMinutes: this.config.rl.minRetrainIntervalMinutes,
        maxConsecutiveNonPromoted: this.config.rl.maxConsecutiveNonPromoted,
        cooldownTradesAfterStop: this.config.rl.cooldownTradesAfterStop,
        cooldownUntilPaperTrades: this.rlCooldownUntilPaperTrades,
      },
    };
  }

  private pickRlWarmStartCheckpoint(): RegisteredModel | undefined {
    const champion = this.registry.getChampion();
    const challengers = this.registry.getChallengers();
    const rlModels = [
      ...(champion && champion.kind === 'rl_linear_q' ? [champion] : []),
      ...challengers.filter(item => item.kind === 'rl_linear_q'),
    ];
    if (rlModels.length === 0) return undefined;

    // Prefer checkpoints with acceptable OOS profile to avoid amplifying in-sample overfit.
    const qualified = rlModels
      .filter(item =>
        (item.evaluation.inSampleWinRate ?? item.metrics.accuracy ?? 0) >= RL_WARMSTART_MIN_WIN_RATE &&
        (item.evaluation.inSampleNetPnl ?? Number.NEGATIVE_INFINITY) > RL_WARMSTART_MIN_NET_PNL &&
        item.evaluation.walkForwardSharpe >= this.config.ml.minWalkForwardSharpe &&
        item.evaluation.walkForwardProfitFactor >= this.config.ml.minWalkForwardProfitFactor &&
        item.evaluation.walkForwardMaxDrawdown <= this.config.ml.maxWalkForwardDrawdown,
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (qualified.length > 0) return qualified[0];

    return this.getBestRlModel();
  }

  private cloneRegimeHeads(heads: RegisteredModel['regimeHeads'] | RlLinearQPolicyModel['regimeHeads'] | undefined): RegisteredModel['regimeHeads'] | undefined {
    if (!heads) return undefined;
    return {
      trend: {
        qWeights: heads.trend.qWeights.map(row => [...row]),
        qBias: [...heads.trend.qBias],
      },
      mean: {
        qWeights: heads.mean.qWeights.map(row => [...row]),
        qBias: [...heads.mean.qBias],
      },
    };
  }

  private asRlPolicy(model: RegisteredModel | undefined): RlLinearQPolicyModel | undefined {
    if (!model || model.kind !== 'rl_linear_q') return undefined;
    if (!Array.isArray(model.qWeights) || model.qWeights.length !== 3) return undefined;
    if (!Array.isArray(model.qBias) || model.qBias.length !== 3) return undefined;
    if (!Array.isArray(model.featureNames) || model.featureNames.length === 0) return undefined;
    return {
      kind: 'rl_linear_q',
      featureNames: [...model.featureNames],
      qWeights: model.qWeights.map(row => [...row]),
      qBias: [...model.qBias],
      regimeHeads: this.cloneRegimeHeads(model.regimeHeads),
      epsilon: 0,
    };
  }

  private buildBacktestOptions(): BacktestOptions {
    return {
      initialCapitalUsd: this.config.execution.initialEquityUsd,
      feeBps: this.config.execution.feeBps,
      slippageBps: this.config.execution.slippageBps,
      latencyBars: 1,
      riskPerTradePct: this.config.risk.maxRiskPerTradePct,
    };
  }

  private evaluateSupervisedWalkForward(
    candles: ReturnType<StateDb['getRecentCandles']>,
    fills: ReturnType<StateDb['getFills']>,
    options: BacktestOptions,
    folds: number,
    purgeBars: number,
  ): SupervisedWalkForwardSummary {
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

    const foldResults: SupervisedWalkForwardFold[] = [];
    const segment = Math.floor(sorted.length / (folds + 1));
    for (let i = 0; i < folds; i += 1) {
      const trainEnd = segment * (i + 1);
      const testStart = trainEnd + Math.max(0, purgeBars);
      const testEnd = Math.min(sorted.length, testStart + segment);
      const trainSlice = sorted.slice(0, trainEnd);
      const testSlice = sorted.slice(testStart, testEnd);
      if (trainSlice.length < 220 || testSlice.length < 80) continue;

      const trainEndTs = sorted[Math.max(0, trainEnd - 1)]?.closeTime ?? 0;
      const trainFills = this.filterFillsByTimestamp(fills, trainEndTs);
      const trainDataset = this.datasetBuilder.build(trainSlice, trainFills);
      if (trainDataset.length < 200) continue;
      const foldModel = this.trainer.train(trainDataset);
      const foldBacktest = new BacktestEngine(() => new SupervisedLinearStrategy(foldModel));
      const result = foldBacktest.run(testSlice, options);
      foldResults.push({
        fold: i + 1,
        trainRange: [sorted[0].openTime, sorted[Math.max(0, trainEnd - 1)].openTime],
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

    return {
      folds: foldResults,
      avgSharpe: average(foldResults.map(item => item.result.sharpe)),
      avgSortino: average(foldResults.map(item => item.result.sortino)),
      avgProfitFactor: average(foldResults.map(item => item.result.profitFactor)),
      avgWinRate: average(foldResults.map(item => item.result.winRate)),
      avgNetPnl: average(foldResults.map(item => item.result.netPnl)),
      maxDrawdown: Math.max(...foldResults.map(item => item.result.maxDrawdown)),
    };
  }

  private checkOosPrefilter(candles: ReturnType<StateDb['getRecentCandles']>): {
    passed: boolean;
    reason: string;
    requiredCandles: number;
    perSymbol: Record<string, number>;
  } {
    const required = Math.max(0, Math.floor(this.config.ml.oosMinCandlesPerSymbol));
    const perSymbol: Record<string, number> = {};
    for (const symbol of this.config.market.symbols) {
      perSymbol[symbol] = 0;
    }
    for (const candle of candles) {
      if (candle.timeframe !== '1m' || candle.source === 'gap_fill') continue;
      perSymbol[candle.symbol] = (perSymbol[candle.symbol] ?? 0) + 1;
    }
    if (required <= 0) {
      return { passed: true, reason: 'oos prefilter disabled', requiredCandles: required, perSymbol };
    }
    const insufficient = Object.entries(perSymbol).filter(([, count]) => count < required);
    if (insufficient.length > 0) {
      return {
        passed: false,
        reason: 'insufficient oos candles per symbol',
        requiredCandles: required,
        perSymbol,
      };
    }
    return { passed: true, reason: 'ok', requiredCandles: required, perSymbol };
  }

  private evaluateEnsembleGate(ensembleSummary: Record<string, unknown> | null): {
    passed: boolean;
    reason: string;
    medianOosProfitFactor?: number;
  } {
    if (!ensembleSummary || (ensembleSummary as { enabled?: boolean }).enabled !== true) {
      return { passed: true, reason: 'ensemble disabled' };
    }
    const median = toFiniteNumber(
      (ensembleSummary as { medianOosProfitFactor?: unknown }).medianOosProfitFactor,
      Number.NaN,
    );
    if (!Number.isFinite(median)) {
      return { passed: false, reason: 'ensemble median OOS unavailable' };
    }
    const threshold = this.config.ml.minPaperProfitFactor;
    if (median < threshold) {
      return {
        passed: false,
        reason: `ensemble median OOS profit factor below threshold (${median.toFixed(4)} < ${threshold.toFixed(4)})`,
        medianOosProfitFactor: median,
      };
    }
    return { passed: true, reason: 'ok', medianOosProfitFactor: median };
  }

  private splitTemporal(
    candles: ReturnType<StateDb['getRecentCandles']>,
    holdoutRatio: number,
    purgeBars: number,
    minTrainCandles: number,
    minHoldoutCandles: number,
  ): TemporalSplit | undefined {
    const sorted = [...candles]
      .filter(item => item.timeframe === '1m' && item.source !== 'gap_fill')
      .sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < minTrainCandles + minHoldoutCandles + 4) return undefined;

    const boundedRatio = Math.min(0.45, Math.max(0.1, holdoutRatio));
    const requestedHoldout = Math.max(minHoldoutCandles, Math.floor(sorted.length * boundedRatio));
    const gap = Math.max(0, Math.floor(purgeBars));

    const trainEnd = sorted.length - requestedHoldout - gap;
    const holdoutStart = trainEnd + gap;
    if (trainEnd < minTrainCandles) return undefined;
    if (holdoutStart >= sorted.length) return undefined;

    const train = sorted.slice(0, trainEnd);
    const holdout = sorted.slice(holdoutStart);
    if (holdout.length < minHoldoutCandles) return undefined;

    return {
      train,
      holdout,
      unseen: [],
      trainEndTs: train[train.length - 1]?.closeTime ?? 0,
      holdoutStartTs: holdout[0]?.openTime ?? 0,
      unseenStartTs: null,
    };
  }

  private splitTemporalWithUnseen(
    candles: ReturnType<StateDb['getRecentCandles']>,
    holdoutRatio: number,
    purgeBars: number,
    minTrainCandles: number,
    minHoldoutCandles: number,
  ): TemporalSplit | undefined {
    const sorted = [...candles]
      .filter(item => item.timeframe === '1m' && item.source !== 'gap_fill')
      .sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < minTrainCandles + minHoldoutCandles + 4) return undefined;

    const unseenBarsRequested = this.config.ml.unseenGateEnabled ? Math.max(0, Math.floor(this.config.ml.unseenBars)) : 0;
    const reserveMax = Math.max(0, sorted.length - (minTrainCandles + minHoldoutCandles + Math.max(0, Math.floor(purgeBars)) + 4));
    const reserveUnseen = Math.min(unseenBarsRequested, reserveMax);
    const trainable = reserveUnseen > 0 ? sorted.slice(0, sorted.length - reserveUnseen) : sorted;
    const unseen = reserveUnseen > 0 ? sorted.slice(sorted.length - reserveUnseen) : [];
    const split = this.splitTemporal(trainable, holdoutRatio, purgeBars, minTrainCandles, minHoldoutCandles);
    if (!split) return undefined;

    return {
      ...split,
      unseen,
      unseenStartTs: unseen.length > 0 ? unseen[0].openTime : null,
    };
  }

  private filterFillsByTimestamp(fills: ReturnType<StateDb['getFills']>, maxTimestampInclusive: number): Fill[] {
    return fills.filter(fill => fill.timestamp <= maxTimestampInclusive);
  }

  private toPaperMetricsFromBacktest(result: BacktestResult): PaperWindowMetrics {
    return {
      trades: result.trades.length,
      winRate: result.winRate,
      sharpe: result.sharpe,
      profitFactor: result.profitFactor,
      maxDrawdownPct: result.maxDrawdown,
      netPnlUsd: result.netPnl,
    };
  }

  private toPaperMetricsFromRl(result: ReturnType<RlTrainer['evaluate']>): PaperWindowMetrics {
    return {
      trades: result.trades.length,
      winRate: result.winRate,
      sharpe: result.sharpe,
      profitFactor: result.profitFactor,
      maxDrawdownPct: result.maxDrawdown,
      netPnlUsd: result.netPnl,
    };
  }

  private buildPromotionThresholds(): {
    simplePromotionEnabled: boolean;
    simplePromotionAllowRl: boolean;
    simplePromotionMinWinRate: number;
    simplePromotionMinNetPnl: number;
    minWalkForwardSharpe: number;
    minWalkForwardProfitFactor: number;
    maxWalkForwardDrawdown: number;
    minPaperProfitFactor: number;
    minPaperSharpe: number;
    minPaperTrades: number;
    unseenGateEnabled: boolean;
    minUnseenProfitFactor: number;
    minUnseenSharpe: number;
    minUnseenTrades: number;
  } {
    return {
      simplePromotionEnabled: this.config.ml.simplePromotionEnabled,
      simplePromotionAllowRl: this.config.ml.simplePromotionAllowRl,
      simplePromotionMinWinRate: this.config.ml.simplePromotionMinWinRate,
      simplePromotionMinNetPnl: this.config.ml.simplePromotionMinNetPnl,
      minWalkForwardSharpe: this.config.ml.minWalkForwardSharpe,
      minWalkForwardProfitFactor: this.config.ml.minWalkForwardProfitFactor,
      maxWalkForwardDrawdown: this.config.ml.maxWalkForwardDrawdown,
      minPaperProfitFactor: this.config.ml.minPaperProfitFactor,
      minPaperSharpe: this.config.ml.minPaperSharpe,
      minPaperTrades: this.config.ml.minPaperTrades,
      unseenGateEnabled: this.config.ml.unseenGateEnabled,
      minUnseenProfitFactor: this.config.ml.unseenMinProfitFactor,
      minUnseenSharpe: this.config.ml.unseenMinSharpe,
      minUnseenTrades: this.config.ml.unseenMinTrades,
    };
  }

  private getRlRetrainBlocker(paperWindow: PaperWindowMetrics): string | null {
    if (this.config.rl.disablePacing) {
      return null;
    }
    const now = Date.now();
    const minIntervalMs = Math.max(0, this.config.rl.minRetrainIntervalMinutes) * 60_000;
    if (this.lastRlRetrainAt > 0 && now - this.lastRlRetrainAt < minIntervalMs) {
      const waitMs = minIntervalMs - (now - this.lastRlRetrainAt);
      return `rl retrain throttled by min interval (${Math.ceil(waitMs / 1000)}s left)`;
    }
    if (paperWindow.trades < this.rlCooldownUntilPaperTrades) {
      return `rl retrain cooldown active until paper trades >= ${this.rlCooldownUntilPaperTrades} (current ${paperWindow.trades})`;
    }
    return null;
  }

  evaluateShadowGate(shadowStatus: Record<string, unknown>): ShadowGateStatus {
    this.refreshRegistry();
    if (!this.config.rl.shadowGateEnabled) {
      return { passed: true, reason: 'shadow gate disabled' };
    }

    const champion = this.getChampionRlModel();
    if (!champion) {
      this.shadowGateState = undefined;
      return { passed: false, reason: 'no rl champion' };
    }
    if (!this.shadowGateState || this.shadowGateState.championId !== champion.id) {
      this.shadowGateState = {
        championId: champion.id,
        activatedAt: Date.now(),
      };
    }

    const trades = toFiniteNumber(shadowStatus.trades, 0);
    const profitFactor = toFiniteNumber(shadowStatus.profitFactor, 0);
    const netPnlUsd = toFiniteNumber(shadowStatus.netPnlUsd, 0);
    const maxDrawdownPct = toFiniteNumber(shadowStatus.maxDrawdownPct, 0);
    const statusElapsedMs = toFiniteNumber(shadowStatus.elapsedMs, NaN);
    const elapsedMs = Number.isFinite(statusElapsedMs)
      ? statusElapsedMs
      : Math.max(0, Date.now() - (this.shadowGateState?.activatedAt ?? Date.now()));

    const tier1 = Math.max(1, Math.floor(this.config.rl.shadowGateTier1Trades));
    const tier2 = Math.max(tier1, Math.floor(this.config.rl.shadowGateTier2Trades));
    const tier3 = Math.max(tier2, Math.floor(this.config.rl.shadowGateTier3Trades));
    const requiredTier = Math.max(1, Math.floor(this.config.rl.shadowGateRequiredTier));
    const currentTier = trades >= tier3 ? tier3 : trades >= tier2 ? tier2 : trades >= tier1 ? tier1 : 0;

    const timeoutHours = requiredTier >= tier3
      ? this.config.rl.shadowGateTier3TimeoutHours
      : requiredTier >= tier2
        ? this.config.rl.shadowGateTier2TimeoutHours
        : this.config.rl.shadowGateTier1TimeoutHours;
    const timeoutMs = Math.max(0, Math.floor(timeoutHours)) * 60 * 60 * 1000;

    const tradesPerMinuteRaw = toFiniteNumber(shadowStatus.tradesPerMinute, NaN);
    const tradesPerMinute = Number.isFinite(tradesPerMinuteRaw)
      ? tradesPerMinuteRaw
      : elapsedMs > 0
        ? trades / (elapsedMs / 60_000)
        : NaN;

    const kpi = {
      tradesPerMinute: Number.isFinite(tradesPerMinute) ? tradesPerMinute : null,
      profitFactor,
      netPnlUsd,
      maxDrawdownPct,
    };
    const kpiPass =
      Number.isFinite(kpi.tradesPerMinute) &&
      (kpi.tradesPerMinute as number) <= this.config.rl.shadowGateMaxTradesPerMinute &&
      profitFactor >= this.config.rl.shadowGateMinProfitFactor &&
      netPnlUsd >= this.config.rl.shadowGateMinNetPnlUsd &&
      maxDrawdownPct <= this.config.rl.shadowGateMaxDrawdownPct;

    const reachedTarget = trades >= requiredTier;
    if (!reachedTarget) {
      const timedOut = timeoutMs > 0 && elapsedMs > timeoutMs;
      return {
        passed: false,
        reason: timedOut ? 'gate_timeout' : 'awaiting_trades',
        tier: requiredTier,
        currentTier,
        trades,
        elapsedMs,
        kpi,
        limits: {
          maxTradesPerMinute: this.config.rl.shadowGateMaxTradesPerMinute,
          minProfitFactor: this.config.rl.shadowGateMinProfitFactor,
          minNetPnlUsd: this.config.rl.shadowGateMinNetPnlUsd,
          maxDrawdownPct: this.config.rl.shadowGateMaxDrawdownPct,
          timeoutMs,
        },
      };
    }

    if (!kpiPass) {
      return {
        passed: false,
        reason: 'kpi_fail',
        tier: requiredTier,
        currentTier,
        trades,
        elapsedMs,
        kpi,
        limits: {
          maxTradesPerMinute: this.config.rl.shadowGateMaxTradesPerMinute,
          minProfitFactor: this.config.rl.shadowGateMinProfitFactor,
          minNetPnlUsd: this.config.rl.shadowGateMinNetPnlUsd,
          maxDrawdownPct: this.config.rl.shadowGateMaxDrawdownPct,
          timeoutMs,
        },
      };
    }

    return {
      passed: true,
      reason: 'pass',
      tier: requiredTier,
      passedTier: requiredTier,
      currentTier,
      trades,
      elapsedMs,
      kpi,
      limits: {
        maxTradesPerMinute: this.config.rl.shadowGateMaxTradesPerMinute,
        minProfitFactor: this.config.rl.shadowGateMinProfitFactor,
        minNetPnlUsd: this.config.rl.shadowGateMinNetPnlUsd,
        maxDrawdownPct: this.config.rl.shadowGateMaxDrawdownPct,
        timeoutMs,
      },
    };
  }

  checkShadowGuard(shadowStatus: Record<string, unknown>): Record<string, unknown> {
    this.refreshRegistry();
    if (!this.config.rl.shadowGuardEnabled) {
      return { checked: false, reason: 'shadow guard disabled' };
    }
    const champion = this.getChampionRlModel();
    if (!champion) {
      this.shadowGuardState = undefined;
      return { checked: false, reason: 'no rl champion' };
    }
    if (!this.shadowGuardState || this.shadowGuardState.championId !== champion.id) {
      this.shadowGuardState = {
        championId: champion.id,
        activatedAt: Date.now(),
      };
      return { checked: true, reason: 'guard armed for champion', championId: champion.id };
    }

    const elapsedMs = Date.now() - this.shadowGuardState.activatedAt;
    const graceMs = Math.max(0, Math.floor(this.config.rl.shadowGuardGraceMinutes)) * 60_000;
    if (elapsedMs < graceMs) {
      return {
        checked: true,
        reason: 'shadow guard grace period',
        championId: champion.id,
        graceLeftMs: Math.max(0, graceMs - elapsedMs),
      };
    }

    const trades = toFiniteNumber(shadowStatus.trades, 0);
    const profitFactor = toFiniteNumber(shadowStatus.profitFactor, 0);
    const maxDrawdownPct = toFiniteNumber(shadowStatus.maxDrawdownPct, 0);
    const netPnlUsd = toFiniteNumber(shadowStatus.netPnlUsd, 0);
    if (trades < this.config.rl.shadowGuardMinTrades) {
      return {
        checked: true,
        reason: 'shadow guard waiting for enough trades',
        championId: champion.id,
        trades,
      };
    }

    const degraded = (
      profitFactor < this.config.rl.shadowGuardMinProfitFactor ||
      maxDrawdownPct > this.config.rl.shadowGuardMaxDrawdownPct ||
      netPnlUsd < this.config.rl.shadowGuardMinNetPnlUsd
    );
    if (!degraded) {
      return {
        checked: true,
        reason: 'shadow guard healthy',
        championId: champion.id,
        trades,
        profitFactor,
        maxDrawdownPct,
        netPnlUsd,
      };
    }

    const rollback = this.registry.rollbackToPreviousChampion();
    if (!rollback.rolledBack) {
      return {
        checked: true,
        rolledBack: false,
        reason: rollback.reason,
        championId: champion.id,
        trades,
        profitFactor,
        maxDrawdownPct,
        netPnlUsd,
      };
    }

    this.logger.error('shadow guard rollback applied', {
      previousChampionId: champion.id,
      restoredChampionId: rollback.champion?.id ?? null,
      trades,
      profitFactor,
      maxDrawdownPct,
      netPnlUsd,
      minTrades: this.config.rl.shadowGuardMinTrades,
      minProfitFactor: this.config.rl.shadowGuardMinProfitFactor,
      maxDrawdownPctLimit: this.config.rl.shadowGuardMaxDrawdownPct,
      minNetPnlUsd: this.config.rl.shadowGuardMinNetPnlUsd,
    });
    this.shadowGuardState = rollback.champion
      ? {
          championId: rollback.champion.id,
          activatedAt: Date.now(),
        }
      : undefined;

    return {
      checked: true,
      rolledBack: true,
      reason: rollback.reason,
      championId: rollback.champion?.id ?? null,
      trades,
      profitFactor,
      maxDrawdownPct,
      netPnlUsd,
    };
  }

  private pickPretrainCandles(candles: Candle[]): Candle[] {
    const months = Math.max(0, Math.floor(this.config.ml.pretrainMonths));
    if (months <= 0) return [];
    if (candles.length < this.config.ml.pretrainMinCandles) return [];
    const sorted = [...candles]
      .filter(item => item.timeframe === '1m' && item.source !== 'gap_fill')
      .sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < this.config.ml.pretrainMinCandles) return [];
    const rangeMs = months * 30 * 24 * 60 * 60 * 1_000;
    const endTs = sorted[sorted.length - 1]?.closeTime ?? 0;
    const startTs = Math.max(0, endTs - rangeMs);
    const selected = sorted.filter(item => item.openTime >= startTs);
    if (selected.length < this.config.ml.pretrainMinCandles) return [];
    return selected;
  }

  private buildHardNegativeReplayCandles(candles: Candle[]): Candle[] {
    if (!this.config.rl.hardNegativeReplayEnabled) return [];
    if (this.rlHardNegativeWindows.length === 0) return [];
    const timeframeCandles = candles
      .filter(item => item.timeframe === '1m' && item.source !== 'gap_fill')
      .sort((a, b) => a.openTime - b.openTime);
    if (timeframeCandles.length === 0) return [];
    const contextMs = Math.max(0, Math.floor(this.config.rl.hardNegativeReplayWindowBars)) * 60_000;
    const windows = this.rlHardNegativeWindows
      .slice(0, Math.max(1, Math.floor(this.config.rl.hardNegativeReplayMaxWindows)));
    const selected = new Map<string, Candle>();
    for (const window of windows) {
      const fromTs = window.startTs - contextMs;
      const toTs = window.endTs + contextMs;
      for (const candle of timeframeCandles) {
        if (candle.openTime < fromTs || candle.openTime > toTs) continue;
        selected.set(`${candle.symbol}:${candle.openTime}`, candle);
      }
    }
    return [...selected.values()].sort((a, b) => a.openTime - b.openTime);
  }

  private rememberHardNegativeWindows(
    wf: ReturnType<RlTrainer['walkForward']>,
    split: TemporalSplit,
    holdout: ReturnType<RlTrainer['evaluate']>,
  ): void {
    if (!this.config.rl.hardNegativeReplayEnabled) return;
    const candidates: HardNegativeWindow[] = [];
    const now = Date.now();

    const add = (startTs: number, endTs: number, score: number, reason: string) => {
      if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return;
      if (endTs <= startTs) return;
      candidates.push({
        startTs,
        endTs,
        score,
        reason,
        createdAt: now,
      });
    };

    if (
      holdout.profitFactor < this.config.ml.minPaperProfitFactor ||
      holdout.trades.length < this.config.ml.minPaperTrades
    ) {
      add(
        split.holdoutStartTs,
        split.holdout[split.holdout.length - 1]?.closeTime ?? split.holdoutStartTs,
        holdout.profitFactor,
        'holdout_fail',
      );
    }

    for (const fold of wf.folds) {
      if (fold.result.profitFactor >= this.config.ml.minWalkForwardProfitFactor) continue;
      add(
        fold.testRange[0],
        fold.testRange[1],
        fold.result.profitFactor,
        `wf_fold_${fold.fold}`,
      );
    }

    if (candidates.length === 0) return;

    const byKey = new Map<string, HardNegativeWindow>();
    const existing = [...this.rlHardNegativeWindows, ...candidates];
    for (const item of existing) {
      const key = `${Math.floor(item.startTs / 60_000)}:${Math.floor(item.endTs / 60_000)}`;
      const prev = byKey.get(key);
      if (!prev || item.score < prev.score || item.createdAt > prev.createdAt) {
        byKey.set(key, item);
      }
    }
    this.rlHardNegativeWindows = [...byKey.values()]
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return b.createdAt - a.createdAt;
      })
      .slice(0, Math.max(1, Math.floor(this.config.rl.hardNegativeReplayMaxWindows)));
  }

  private auditPromotion(challengerId: string, reason: string, wfSharpe: number, paperProfitFactor: number): void {
    this.db.insertAudit({
      id: randomUUID(),
      type: 'model_promotion',
      timestamp: Date.now(),
      payload: {
        challengerId,
        reason,
        wfSharpe,
        paperProfitFactor,
      },
    });
  }
}

const average = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const RL_WARMSTART_MIN_WIN_RATE = 0.5;
const RL_WARMSTART_MIN_NET_PNL = 0;
