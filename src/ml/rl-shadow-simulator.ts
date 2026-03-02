import type { AppConfig } from '../core/config.js';
import type { Candle } from '../core/types.js';
import { computeExecutionCosts } from '../execution/execution-model.js';
import { Logger } from '../state/logger.js';
import { extractFeatures, featureLookback } from './features.js';
import { actionIndexToValue, selectActionWithConfidence, type RlLinearQPolicyModel } from './rl-policy.js';
import type { RegisteredModel } from './model-registry.js';

interface ShadowSymbolState {
  symbol: string;
  step: number;
  position: -1 | 0 | 1;
  positionEntryStep: number;
  lastTurnoverStep: number;
  lastFlipStep: number;
  entryPrice: number;
  entryTs: number;
  lastClose?: number;
  candles: Candle[];
  pending: Array<{ executeAtStep: number; action: -1 | 0 | 1; qGap: number }>;
}

interface ClosedTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
}

export class RlShadowSimulator {
  private readonly logger: Logger;
  private readonly bySymbol = new Map<string, ShadowSymbolState>();
  private readonly capitalBySymbol = new Map<string, number>();
  private readonly trades: ClosedTrade[] = [];
  private initialCapitalUsd: number;
  private peakEquityUsd: number;
  private totalCostsUsd = 0;
  private enabled = true;
  private qGapSamples: number[] = [];
  private guardBlocks = { confidence: 0, minHold: 0, flipCooldown: 0, lowStrength: 0, confidenceTriggered: 0 };
  private actionsBeforeGuards = 0;
  private actionsAfterGuards = 0;
  private regimeCounts = { trend: 0, mean: 0 };
  private startedAt = Date.now();
  private firstTradeTs?: number;
  private lastTradeTs?: number;

  constructor(
    logger: Logger,
    private readonly config: AppConfig,
    private readonly modelProvider: () => RegisteredModel | undefined,
  ) {
    this.logger = logger.child('rl-shadow');
    this.initialCapitalUsd = config.execution.initialEquityUsd;
    this.peakEquityUsd = this.initialCapitalUsd;
  }

  start(): void {
    this.enabled = this.config.rl.shadowEnabled;
    this.startedAt = Date.now();
    this.firstTradeTs = undefined;
    this.lastTradeTs = undefined;
    this.regimeCounts = { trend: 0, mean: 0 };
  }

  stop(): void {
    this.enabled = false;
  }

  reset(): void {
    this.bySymbol.clear();
    this.capitalBySymbol.clear();
    this.trades.splice(0);
    this.totalCostsUsd = 0;
    this.qGapSamples = [];
    this.initialCapitalUsd = this.config.execution.initialEquityUsd;
    this.peakEquityUsd = this.initialCapitalUsd;
    this.guardBlocks = { confidence: 0, minHold: 0, flipCooldown: 0, lowStrength: 0, confidenceTriggered: 0 };
    this.actionsBeforeGuards = 0;
    this.actionsAfterGuards = 0;
    this.regimeCounts = { trend: 0, mean: 0 };
    this.startedAt = Date.now();
    this.firstTradeTs = undefined;
    this.lastTradeTs = undefined;
  }

  onCandle(candle: Candle): void {
    if (!this.enabled) return;
    if (candle.timeframe !== '1m') return;

    const model = this.asRlModel(this.modelProvider());
    if (!model) return;

    const state = this.getOrCreateState(candle.symbol);
    state.step += 1;
    state.candles.push(candle);
    if (state.candles.length > 600) state.candles.splice(0, state.candles.length - 600);

    if (state.lastClose !== undefined) {
      const ret = (candle.close - state.lastClose) / Math.max(1e-9, state.lastClose);
      const equity = this.capitalBySymbol.get(candle.symbol) ?? this.initialCapitalUsd / Math.max(1, this.config.market.symbols.length);
      const notional = equity * (this.config.risk.maxRiskPerTradePct / 100) * Math.max(0.2, Math.abs(state.position));
      const pnl = notional * state.position * ret;
      this.capitalBySymbol.set(candle.symbol, equity + pnl);
    }
    state.lastClose = candle.close;

    this.applyPending(state, candle);
    if (state.candles.length < featureLookback) return;

    const window = state.candles.slice(state.candles.length - featureLookback);
    const positionAge = state.position === 0 ? 0 : Math.max(0, state.step - state.positionEntryStep);
    const lastTurnoverAge = Math.max(0, state.step - state.lastTurnoverStep);
    const features = extractFeatures(window, [], {
      position: state.position,
      positionAge,
      lastTurnoverAge,
    });
    const selection = selectActionWithConfidence({
      features,
      model,
      epsilon: 0,
      confidenceGateEnabled: false,
      confidenceQGap: this.config.rl.confidenceQGap,
    });
    if (this.config.rl.regimeSplitEnabled) {
      if (selection.regime === 'trend' || selection.regime === 'mean') {
        this.regimeCounts[selection.regime] += 1;
      }
    }
    let desiredAction = actionIndexToValue(selection.actionIdx);
    const maxPositionBars = Math.max(0, Math.floor(this.config.rl.maxPositionBars));
    if (state.position !== 0 && maxPositionBars > 0) {
      const currentPositionAge = Math.max(0, state.step - state.positionEntryStep);
      if (currentPositionAge >= maxPositionBars && desiredAction === state.position) {
        desiredAction = 0;
      }
    }
    if (desiredAction !== state.position) {
      this.actionsBeforeGuards += 1;
    }
    this.recordQGap(selection.qGap);
    state.pending.push({
      executeAtStep: state.step + Math.max(1, this.config.rl.latencyBars),
      action: desiredAction,
      qGap: selection.qGap,
    });

    const total = this.totalEquity();
    this.peakEquityUsd = Math.max(this.peakEquityUsd, total);
  }

  getStatus(): Record<string, unknown> {
    const winTrades = this.trades.filter(trade => trade.pnlUsd > 0);
    const loseTrades = this.trades.filter(trade => trade.pnlUsd < 0);
    const grossProfit = winTrades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
    const grossLossAbs = Math.abs(loseTrades.reduce((sum, trade) => sum + trade.pnlUsd, 0));
    const totalEquity = this.totalEquity();
    const maxDrawdownPct = this.peakEquityUsd <= 0 ? 0 : ((this.peakEquityUsd - totalEquity) / this.peakEquityUsd) * 100;
    const elapsedMs = Date.now() - (this.firstTradeTs ?? this.startedAt);
    const elapsedMinutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;
    const tradesPerMinute = elapsedMinutes > 0 ? this.trades.length / elapsedMinutes : null;
    const regimeTotal = this.regimeCounts.trend + this.regimeCounts.mean;
    const regimeStats = this.config.rl.regimeSplitEnabled
      ? {
          trend: this.regimeCounts.trend,
          mean: this.regimeCounts.mean,
          total: regimeTotal,
          trendPct: regimeTotal > 0 ? this.regimeCounts.trend / regimeTotal : null,
          meanPct: regimeTotal > 0 ? this.regimeCounts.mean / regimeTotal : null,
        }
      : null;
    return {
      enabled: this.enabled,
      modelKind: this.asRlModel(this.modelProvider()) ? 'rl_linear_q' : 'none',
      initialCapitalUsd: this.initialCapitalUsd,
      equityUsd: totalEquity,
      netPnlUsd: totalEquity - this.initialCapitalUsd,
      totalCostsUsd: this.totalCostsUsd,
      maxDrawdownPct,
      trades: this.trades.length,
      tradesPerMinute,
      startedAt: this.startedAt,
      elapsedMs,
      firstTradeTs: this.firstTradeTs ?? null,
      lastTradeTs: this.lastTradeTs ?? null,
      winRate: this.trades.length === 0 ? 0 : winTrades.length / this.trades.length,
      profitFactor: grossLossAbs === 0 ? (grossProfit > 0 ? 50 : 0) : Math.min(50, grossProfit / grossLossAbs),
      qGapStats: this.qGapStats(),
      regimeStats,
      symbols: [...this.bySymbol.keys()],
      openPositions: [...this.bySymbol.values()]
        .filter(item => item.position !== 0)
        .map(item => ({
          symbol: item.symbol,
          side: item.position > 0 ? 'long' : 'short',
          entryPrice: item.entryPrice,
          entryTs: item.entryTs,
        })),
      guardBlocks: {
        confidence: this.guardBlocks.confidence,
        minHold: this.guardBlocks.minHold,
        flipCooldown: this.guardBlocks.flipCooldown,
        lowStrength: this.guardBlocks.lowStrength,
        confidenceTriggered: this.guardBlocks.confidenceTriggered,
        total: this.guardBlocks.confidence + this.guardBlocks.minHold + this.guardBlocks.flipCooldown + this.guardBlocks.lowStrength,
        actionsBeforeGuards: this.actionsBeforeGuards,
        actionsAfterGuards: this.actionsAfterGuards,
        confidenceGateEnabled: this.config.rl.confidenceGateEnabled,
        confidenceQGap: this.config.rl.confidenceQGap,
        effectiveConfidenceQGap: this.resolveConfidenceQGapThreshold(),
        confidenceQGapAdaptiveEnabled: this.config.rl.confidenceQGapAdaptiveEnabled,
        confidenceQGapAdaptiveQuantile: this.config.rl.confidenceQGapAdaptiveQuantile,
        confidenceQGapAdaptiveScale: this.config.rl.confidenceQGapAdaptiveScale,
        confidenceQGapMin: this.config.rl.confidenceQGapMin,
        minSignalStrength: this.config.rl.minSignalStrength,
      },
    };
  }

  private applyPending(state: ShadowSymbolState, candle: Candle): void {
    const equity = this.capitalBySymbol.get(candle.symbol) ?? this.initialCapitalUsd / Math.max(1, this.config.market.symbols.length);
    const featureWindow = state.candles.length >= featureLookback
      ? state.candles.slice(state.candles.length - featureLookback)
      : null;
    const positionAge = state.position === 0 ? 0 : Math.max(0, state.step - state.positionEntryStep);
    const lastTurnoverAge = Math.max(0, state.step - state.lastTurnoverStep);
    const slippageFeatures = featureWindow
      ? extractFeatures(featureWindow, [], {
        position: state.position,
        positionAge,
        lastTurnoverAge,
      })
      : null;
    const volatility = slippageFeatures ? slippageFeatures[1] : 0;
    const macdHist = slippageFeatures ? slippageFeatures[5] : 0;
    while (state.pending.length > 0 && state.pending[0].executeAtStep <= state.step) {
      const update = state.pending.shift();
      if (!update) break;
      const turnover = Math.abs(update.action - state.position);
      if (turnover <= 0) continue;
      const confidenceQGap = this.resolveConfidenceQGapThreshold();
      const confidenceGateTriggered =
        this.config.rl.confidenceGateEnabled &&
        Number.isFinite(update.qGap) &&
        update.qGap < confidenceQGap;
      if (confidenceGateTriggered) {
        this.guardBlocks.confidenceTriggered += 1;
        this.guardBlocks.confidence += 1;
        continue;
      }
      const positionAge = state.position === 0 ? 0 : Math.max(0, state.step - state.positionEntryStep);
      const minHold = Math.max(0, Math.floor(this.config.rl.minHoldBars));
      if (state.position !== 0 && positionAge < minHold) {
        this.guardBlocks.minHold += 1;
        continue;
      }
      const flipCooldown = Math.max(0, Math.floor(this.config.rl.flipCooldownBars));
      if (state.lastFlipStep > 0 && state.step - state.lastFlipStep < flipCooldown) {
        this.guardBlocks.flipCooldown += 1;
        continue;
      }
      this.actionsAfterGuards += 1;

      if (state.position !== 0) {
        const closed = this.closeTrade(state, candle, equity);
        if (closed) {
          this.trades.push(closed);
          if (!this.firstTradeTs) this.firstTradeTs = closed.exitTs;
          this.lastTradeTs = closed.exitTs;
        }
      }

      const notional = equity * (this.config.risk.maxRiskPerTradePct / 100) * Math.max(0.2, Math.abs(update.action));
      const execCosts = computeExecutionCosts({
        notionalUsd: notional,
        turnover,
        feeBps: this.config.execution.feeBps,
        slippageBps: this.config.execution.slippageBps,
        turnoverPenaltyBps: this.config.rl.turnoverPenaltyBps,
        volatility,
        macdHistNorm: macdHist,
      });
      const costs = execCosts.totalCost;
      this.totalCostsUsd += costs;
      this.capitalBySymbol.set(candle.symbol, (this.capitalBySymbol.get(candle.symbol) ?? equity) - costs);

      state.position = update.action;
      if (state.position !== 0) {
        state.entryPrice = candle.close;
        state.entryTs = candle.openTime;
        state.positionEntryStep = state.step;
      } else {
        state.entryPrice = 0;
        state.entryTs = 0;
        state.positionEntryStep = state.step;
      }
      state.lastTurnoverStep = state.step;
      if (turnover === 2) {
        state.lastFlipStep = state.step;
      }
    }
  }

  private closeTrade(state: ShadowSymbolState, candle: Candle, equity: number): ClosedTrade | undefined {
    if (state.position === 0 || state.entryPrice <= 0) return undefined;
    const side: 'long' | 'short' = state.position > 0 ? 'long' : 'short';
    const notional = equity * (this.config.risk.maxRiskPerTradePct / 100) * Math.max(0.2, Math.abs(state.position));
    const quantity = notional / Math.max(1e-9, state.entryPrice);
    const pnlUsd = side === 'long'
      ? quantity * (candle.close - state.entryPrice)
      : quantity * (state.entryPrice - candle.close);
    const exitTs = Math.min(candle.closeTime, Date.now());
    return {
      symbol: state.symbol,
      side,
      entryTs: state.entryTs,
      exitTs,
      entryPrice: state.entryPrice,
      exitPrice: candle.close,
      quantity,
      pnlUsd,
    };
  }

  private getOrCreateState(symbol: string): ShadowSymbolState {
    const existing = this.bySymbol.get(symbol);
    if (existing) return existing;
    const state: ShadowSymbolState = {
      symbol,
      step: 0,
      position: 0,
      positionEntryStep: 0,
      lastTurnoverStep: 0,
      lastFlipStep: 0,
      entryPrice: 0,
      entryTs: 0,
      candles: [],
      pending: [],
    };
    this.bySymbol.set(symbol, state);
    if (!this.capitalBySymbol.has(symbol)) {
      this.capitalBySymbol.set(symbol, this.initialCapitalUsd / Math.max(1, this.config.market.symbols.length));
    }
    return state;
  }

  private totalEquity(): number {
    let total = 0;
    for (const value of this.capitalBySymbol.values()) total += value;
    return total || this.initialCapitalUsd;
  }

  private recordQGap(value: number): void {
    if (!Number.isFinite(value)) return;
    this.qGapSamples.push(value);
    if (this.qGapSamples.length > 5000) {
      this.qGapSamples.splice(0, this.qGapSamples.length - 5000);
    }
  }

  private qGapStats(): { p50: number; p75: number; p90: number } | null {
    if (this.qGapSamples.length === 0) return null;
    const sorted = [...this.qGapSamples].sort((a, b) => a - b);
    return {
      p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p75: sorted[Math.floor(sorted.length * 0.75)] ?? 0,
      p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
    };
  }

  private resolveConfidenceQGapThreshold(): number {
    const base = Math.max(0, this.config.rl.confidenceQGap);
    if (!this.config.rl.confidenceQGapAdaptiveEnabled) return base;
    const minThreshold = Math.max(0, this.config.rl.confidenceQGapMin);
    if (this.qGapSamples.length < 12) {
      const warmupThreshold = base * 0.35;
      return clamp(warmupThreshold, minThreshold, base);
    }

    const sorted = [...this.qGapSamples].sort((a, b) => a - b);
    const quantile = clamp(this.config.rl.confidenceQGapAdaptiveQuantile, 0.35, 0.95);
    const idx = Math.floor((sorted.length - 1) * quantile);
    const qValue = sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? base;
    const scaled = qValue * Math.max(0.1, this.config.rl.confidenceQGapAdaptiveScale);
    const adaptive = Math.max(minThreshold, scaled);
    let threshold = Math.min(base, adaptive);

    if (this.actionsBeforeGuards >= 20) {
      const passRate = this.actionsAfterGuards / Math.max(1, this.actionsBeforeGuards);
      const targetPassRate = 0.2;
      if (passRate < targetPassRate) {
        const relaxFactor = Math.max(0.2, passRate / targetPassRate);
        threshold *= relaxFactor;
      }
    }

    return clamp(threshold, minThreshold, base);
  }

  private asRlModel(model: RegisteredModel | undefined): RlLinearQPolicyModel | undefined {
    if (!model) return undefined;
    if (model.kind !== 'rl_linear_q') return undefined;
    if (!model.qWeights || !model.qBias) return undefined;
    const regimeHeads = model.regimeHeads
      ? {
          trend: {
            qWeights: model.regimeHeads.trend.qWeights.map(row => [...row]),
            qBias: [...model.regimeHeads.trend.qBias],
          },
          mean: {
            qWeights: model.regimeHeads.mean.qWeights.map(row => [...row]),
            qBias: [...model.regimeHeads.mean.qBias],
          },
        }
      : undefined;
    return {
      kind: 'rl_linear_q',
      featureNames: model.featureNames,
      qWeights: model.qWeights,
      qBias: model.qBias,
      regimeHeads,
      epsilon: 0,
    };
  }
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
