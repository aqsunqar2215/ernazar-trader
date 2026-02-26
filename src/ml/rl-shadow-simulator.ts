import type { AppConfig } from '../core/config.js';
import type { Candle } from '../core/types.js';
import { Logger } from '../state/logger.js';
import { extractFeatures, featureLookback } from './features.js';
import { actionIndexToValue, greedyActionIndex, type RlLinearQPolicyModel } from './rl-policy.js';
import type { RegisteredModel } from './model-registry.js';

interface ShadowSymbolState {
  symbol: string;
  step: number;
  position: -1 | 0 | 1;
  entryPrice: number;
  entryTs: number;
  lastClose?: number;
  candles: Candle[];
  pending: Array<{ executeAtStep: number; action: -1 | 0 | 1 }>;
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
  }

  stop(): void {
    this.enabled = false;
  }

  reset(): void {
    this.bySymbol.clear();
    this.capitalBySymbol.clear();
    this.trades.splice(0);
    this.totalCostsUsd = 0;
    this.initialCapitalUsd = this.config.execution.initialEquityUsd;
    this.peakEquityUsd = this.initialCapitalUsd;
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
    const features = extractFeatures(window);
    const actionIndex = greedyActionIndex(features, model);
    const action = actionIndexToValue(actionIndex);
    state.pending.push({
      executeAtStep: state.step + Math.max(1, this.config.rl.latencyBars),
      action,
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
    return {
      enabled: this.enabled,
      modelKind: this.asRlModel(this.modelProvider()) ? 'rl_linear_q' : 'none',
      initialCapitalUsd: this.initialCapitalUsd,
      equityUsd: totalEquity,
      netPnlUsd: totalEquity - this.initialCapitalUsd,
      totalCostsUsd: this.totalCostsUsd,
      maxDrawdownPct,
      trades: this.trades.length,
      winRate: this.trades.length === 0 ? 0 : winTrades.length / this.trades.length,
      profitFactor: grossLossAbs === 0 ? (grossProfit > 0 ? 50 : 0) : Math.min(50, grossProfit / grossLossAbs),
      symbols: [...this.bySymbol.keys()],
      openPositions: [...this.bySymbol.values()]
        .filter(item => item.position !== 0)
        .map(item => ({
          symbol: item.symbol,
          side: item.position > 0 ? 'long' : 'short',
          entryPrice: item.entryPrice,
          entryTs: item.entryTs,
        })),
    };
  }

  private applyPending(state: ShadowSymbolState, candle: Candle): void {
    const equity = this.capitalBySymbol.get(candle.symbol) ?? this.initialCapitalUsd / Math.max(1, this.config.market.symbols.length);
    while (state.pending.length > 0 && state.pending[0].executeAtStep <= state.step) {
      const update = state.pending.shift();
      if (!update) break;
      const turnover = Math.abs(update.action - state.position);
      if (turnover <= 0) continue;

      if (state.position !== 0) {
        const closed = this.closeTrade(state, candle, equity);
        if (closed) this.trades.push(closed);
      }

      const notional = equity * (this.config.risk.maxRiskPerTradePct / 100) * Math.max(0.2, Math.abs(update.action));
      const slipBps = this.config.execution.slippageBps;
      const feeCost = notional * ((this.config.execution.feeBps + slipBps) / 10_000) * turnover;
      const turnoverPenalty = notional * (this.config.rl.turnoverPenaltyBps / 10_000) * turnover;
      const costs = feeCost + turnoverPenalty;
      this.totalCostsUsd += costs;
      this.capitalBySymbol.set(candle.symbol, (this.capitalBySymbol.get(candle.symbol) ?? equity) - costs);

      state.position = update.action;
      if (state.position !== 0) {
        state.entryPrice = candle.close;
        state.entryTs = candle.openTime;
      } else {
        state.entryPrice = 0;
        state.entryTs = 0;
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
    return {
      symbol: state.symbol,
      side,
      entryTs: state.entryTs,
      exitTs: candle.closeTime,
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

  private asRlModel(model: RegisteredModel | undefined): RlLinearQPolicyModel | undefined {
    if (!model) return undefined;
    if (model.kind !== 'rl_linear_q') return undefined;
    if (!model.qWeights || !model.qBias) return undefined;
    return {
      kind: 'rl_linear_q',
      featureNames: model.featureNames,
      qWeights: model.qWeights,
      qBias: model.qBias,
      epsilon: 0,
    };
  }
}
