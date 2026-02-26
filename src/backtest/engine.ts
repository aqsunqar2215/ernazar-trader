import type { Candle, Signal } from '../core/types.js';
import { computeExecutionCosts } from '../execution/execution-model.js';
import { extractFeatures, featureLookback } from '../ml/features.js';
import type { Strategy } from '../strategy/strategy.js';

export interface BacktestTrade {
  symbol: string;
  entryTs: number;
  exitTs: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
}

export interface BacktestResult {
  netPnl: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  winRate: number;
  profitFactor: number;
  equityCurve: number[];
  trades: BacktestTrade[];
}

export interface BacktestOptions {
  initialCapitalUsd: number;
  feeBps: number;
  slippageBps: number;
  latencyBars: number;
  riskPerTradePct: number;
  turnoverPenaltyBps?: number;
}

interface PositionState {
  symbol: string;
  quantity: number;
  entryPrice: number;
  entryTs: number;
  notionalUsd: number;
  entryCostUsd: number;
}

export class BacktestEngine {
  constructor(private readonly strategyFactory: () => Strategy) {}

  run(candles: Candle[], options: BacktestOptions): BacktestResult {
    if (candles.length < 60) {
      return {
        netPnl: 0,
        maxDrawdown: 0,
        sharpe: 0,
        sortino: 0,
        winRate: 0,
        profitFactor: 0,
        equityCurve: [options.initialCapitalUsd],
        trades: [],
      };
    }

    const strategy = this.strategyFactory();
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    const pendingSignals = new Map<string, Array<{ signal: Signal; remaining: number }>>();
    const trades: BacktestTrade[] = [];
    const returns: number[] = [];
    let capital = options.initialCapitalUsd;
    let peak = capital;
    let maxDrawdown = 0;
    const positions = new Map<string, PositionState>();
    const lastPrices = new Map<string, number>();
    const lastCandles = new Map<string, Candle>();
    const equityCurve: number[] = [capital];
    const featureWindows = new Map<string, Candle[]>();

    for (let i = 0; i < sorted.length; i += 1) {
      const candle = sorted[i];
      lastPrices.set(candle.symbol, candle.close);
      lastCandles.set(candle.symbol, candle);
      const window = featureWindows.get(candle.symbol) ?? [];
      window.push(candle);
      if (window.length > featureLookback) {
        window.splice(0, window.length - featureLookback);
      }
      featureWindows.set(candle.symbol, window);
      const slippageFeatures = window.length >= featureLookback
        ? extractFeatures(window, [], { position: 0, positionAge: 0, lastTurnoverAge: 0 })
        : null;
      const volatility = slippageFeatures ? slippageFeatures[1] : 0;
      const macdHist = slippageFeatures ? slippageFeatures[5] : 0;
      const signal = strategy.onCandle(candle);
      const latency = Math.max(1, options.latencyBars);
      const queue = pendingSignals.get(candle.symbol) ?? [];
      for (const item of queue) {
        item.remaining -= 1;
      }
      queue.push({
        signal,
        remaining: latency,
      });

      const executable: Array<{ signal: Signal; remaining: number }> = [];
      const pending: Array<{ signal: Signal; remaining: number }> = [];
      for (const item of queue) {
        if (item.remaining <= 0) {
          executable.push(item);
        } else {
          pending.push(item);
        }
      }
      pendingSignals.set(candle.symbol, pending);

      for (const item of executable) {
        const markPrice = candle.close;
        const symbol = candle.symbol;
        let position = positions.get(symbol) ?? null;
        const turnoverPenaltyBps = options.turnoverPenaltyBps ?? 0;

        if (item.signal.action === 'buy') {
          if (position && position.quantity < 0) {
            const closeCosts = computeExecutionCosts({
              notionalUsd: position.notionalUsd,
              turnover: 1,
              feeBps: options.feeBps,
              slippageBps: options.slippageBps,
              turnoverPenaltyBps,
              volatility,
              macdHistNorm: macdHist,
            });
            capital -= closeCosts.totalCost;
            const qtyToClose = Math.abs(position.quantity);
            const gross = (position.entryPrice - markPrice) * qtyToClose;
            capital += gross;
            const net = gross - position.entryCostUsd - closeCosts.totalCost;
            returns.push(net / Math.max(1, capital));
            trades.push({
              symbol,
              entryTs: position.entryTs,
              exitTs: candle.closeTime,
              side: 'short',
              entryPrice: position.entryPrice,
              exitPrice: markPrice,
              quantity: qtyToClose,
              pnlUsd: net,
            });
            positions.delete(symbol);
            position = null;
          }

          if (!position) {
            const notional = capital * (options.riskPerTradePct / 100) * Math.max(0.2, item.signal.strength);
            const qty = notional / Math.max(1e-9, markPrice);
            const openCosts = computeExecutionCosts({
              notionalUsd: notional,
              turnover: 1,
              feeBps: options.feeBps,
              slippageBps: options.slippageBps,
              turnoverPenaltyBps,
              volatility,
              macdHistNorm: macdHist,
            });
            capital -= openCosts.totalCost;
            positions.set(symbol, {
              symbol,
              quantity: qty,
              entryPrice: markPrice,
              entryTs: candle.openTime,
              notionalUsd: notional,
              entryCostUsd: openCosts.totalCost,
            });
          }
        } else if (item.signal.action === 'sell') {
          if (position && position.quantity > 0) {
            const closeCosts = computeExecutionCosts({
              notionalUsd: position.notionalUsd,
              turnover: 1,
              feeBps: options.feeBps,
              slippageBps: options.slippageBps,
              turnoverPenaltyBps,
              volatility,
              macdHistNorm: macdHist,
            });
            capital -= closeCosts.totalCost;
            const qtyToClose = position.quantity;
            const gross = (markPrice - position.entryPrice) * qtyToClose;
            capital += gross;
            const net = gross - position.entryCostUsd - closeCosts.totalCost;
            returns.push(net / Math.max(1, capital));
            trades.push({
              symbol,
              entryTs: position.entryTs,
              exitTs: candle.closeTime,
              side: 'long',
              entryPrice: position.entryPrice,
              exitPrice: markPrice,
              quantity: qtyToClose,
              pnlUsd: net,
            });
            positions.delete(symbol);
            position = null;
          }

          if (!position) {
            const notional = capital * (options.riskPerTradePct / 100) * Math.max(0.2, item.signal.strength);
            const qty = notional / Math.max(1e-9, markPrice);
            const openCosts = computeExecutionCosts({
              notionalUsd: notional,
              turnover: 1,
              feeBps: options.feeBps,
              slippageBps: options.slippageBps,
              turnoverPenaltyBps,
              volatility,
              macdHistNorm: macdHist,
            });
            capital -= openCosts.totalCost;
            positions.set(symbol, {
              symbol,
              quantity: -qty,
              entryPrice: markPrice,
              entryTs: candle.openTime,
              notionalUsd: notional,
              entryCostUsd: openCosts.totalCost,
            });
          }
        }
      }

      if (positions.size > 0) {
        let totalUnrealized = 0;
        for (const [sym, pos] of positions) {
          const mark = lastPrices.get(sym) ?? candle.close;
          const unrealized =
            pos.quantity > 0
              ? (mark - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - mark) * Math.abs(pos.quantity);
          totalUnrealized += unrealized;
        }
        equityCurve.push(capital + totalUnrealized);
      } else {
        equityCurve.push(capital);
      }
      peak = Math.max(peak, equityCurve[equityCurve.length - 1]);
      const dd = peak === 0 ? 0 : (peak - equityCurve[equityCurve.length - 1]) / peak;
      maxDrawdown = Math.max(maxDrawdown, dd);
    }

    if (positions.size > 0) {
      for (const [sym, position] of positions) {
        const last = lastCandles.get(sym);
        const exitPrice = last?.close ?? lastPrices.get(sym) ?? position.entryPrice;
        const exitTs = last?.closeTime ?? position.entryTs;
        const featureWindow = featureWindows.get(sym) ?? [];
        const slippageFeatures = featureWindow.length >= featureLookback
          ? extractFeatures(featureWindow, [], { position: 0, positionAge: 0, lastTurnoverAge: 0 })
          : null;
        const volatility = slippageFeatures ? slippageFeatures[1] : 0;
        const macdHist = slippageFeatures ? slippageFeatures[5] : 0;
        const turnoverPenaltyBps = options.turnoverPenaltyBps ?? 0;
        if (position.quantity > 0) {
          const qty = position.quantity;
          const closeCosts = computeExecutionCosts({
            notionalUsd: position.notionalUsd,
            turnover: 1,
            feeBps: options.feeBps,
            slippageBps: options.slippageBps,
            turnoverPenaltyBps,
            volatility,
            macdHistNorm: macdHist,
          });
          capital -= closeCosts.totalCost;
          const gross = (exitPrice - position.entryPrice) * qty;
          capital += gross;
          const net = gross - position.entryCostUsd - closeCosts.totalCost;
          returns.push(net / Math.max(1, capital));
          trades.push({
            symbol: sym,
            entryTs: position.entryTs,
            exitTs,
            side: 'long',
            entryPrice: position.entryPrice,
            exitPrice,
            quantity: qty,
            pnlUsd: net,
          });
        } else {
          const qty = Math.abs(position.quantity);
          const closeCosts = computeExecutionCosts({
            notionalUsd: position.notionalUsd,
            turnover: 1,
            feeBps: options.feeBps,
            slippageBps: options.slippageBps,
            turnoverPenaltyBps,
            volatility,
            macdHistNorm: macdHist,
          });
          capital -= closeCosts.totalCost;
          const gross = (position.entryPrice - exitPrice) * qty;
          capital += gross;
          const net = gross - position.entryCostUsd - closeCosts.totalCost;
          returns.push(net / Math.max(1, capital));
          trades.push({
            symbol: sym,
            entryTs: position.entryTs,
            exitTs,
            side: 'short',
            entryPrice: position.entryPrice,
            exitPrice,
            quantity: qty,
            pnlUsd: net,
          });
        }
      }
    }

    const wins = trades.filter(trade => trade.pnlUsd > 0);
    const losses = trades.filter(trade => trade.pnlUsd < 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
    const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
    const winRate = trades.length === 0 ? 0 : wins.length / trades.length;
    const profitFactor = grossLossAbs === 0 ? (grossProfit > 0 ? 50 : 0) : Math.min(50, grossProfit / grossLossAbs);

    const sharpe = computeSharpe(returns);
    const sortino = computeSortino(returns);

    return {
      netPnl: capital - options.initialCapitalUsd,
      maxDrawdown,
      sharpe,
      sortino,
      winRate,
      profitFactor,
      equityCurve,
      trades,
    };
  }
}

const computeSharpe = (returns: number[]): number => {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(Math.max(variance, 0));
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
};

const computeSortino = (returns: number[]): number => {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const downside = returns.filter(value => value < 0);
  if (downside.length === 0) return 0;
  const downsideVariance = downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return 0;
  return (mean / downsideDev) * Math.sqrt(252);
};
