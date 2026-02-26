import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../core/config.js';
import type { AlertEvent, AuditEvent, Candle, EquityPoint, Signal } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { MarketDataFeed } from '../market/market-feed.js';
import { OrderManager } from '../execution/order-manager.js';
import { RiskEngine } from '../risk/risk-engine.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { MomentumMeanReversionStrategy } from '../strategy/momentum-mean-reversion.js';
import { RolloutPolicy } from './rollout-policy.js';

interface PaperMetrics {
  trades: number;
  wins: number;
  losses: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  netPnlUsd: number;
  maxDrawdownPct: number;
}

export class TradingEngine {
  private readonly logger: Logger;
  private readonly strategy = new MomentumMeanReversionStrategy();
  private readonly risk: RiskEngine;
  private readonly killSwitch = new KillSwitch();
  private readonly rollout: RolloutPolicy;
  private readonly orderTimes: number[] = [];
  private started = false;
  private cashUsd: number;
  private realizedPnlUsd = 0;
  private unrealizedPnlUsd = 0;
  private peakEquityUsd: number;
  private dayRealizedBaseline = 0;
  private dayKey = this.currentDayKey();
  private recentLossStreak = 0;
  private paperMetrics: PaperMetrics = {
    trades: 0,
    wins: 0,
    losses: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    netPnlUsd: 0,
    maxDrawdownPct: 0,
  };
  private alerts: AlertEvent[] = [];
  private backtestGatePassed = false;
  private backtestGateReason = 'not evaluated';
  private backtestAlerted = false;
  private tinyLiveRiskMultiplier = 0.1;

  constructor(
    private readonly db: StateDb,
    private readonly feed: MarketDataFeed,
    private readonly orderManager: OrderManager,
    logger: Logger,
    private readonly config: AppConfig,
  ) {
    this.logger = logger.child('trading-engine');
    this.cashUsd = config.execution.initialEquityUsd;
    this.peakEquityUsd = config.execution.initialEquityUsd;
    this.risk = new RiskEngine({
      maxRiskPerTradePct: config.risk.maxRiskPerTradePct,
      maxDailyLossUsd: config.risk.maxDailyLossUsd,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      maxOrdersPerMinute: config.risk.maxOrdersPerMinute,
      cooldownLossStreak: config.risk.cooldownLossStreak,
    });
    this.rollout = new RolloutPolicy({
      requestedMode: config.rollout.mode,
      minTradesForTinyLive: 30,
      minProfitFactor: config.ml.minPaperProfitFactor,
      maxDrawdownPct: Math.max(4, config.risk.maxDrawdownPct * 0.8),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.orderManager.reconcile();
    this.feed.on('candle', (candle: Candle) => {
      void this.onCandle(candle);
    });
    this.started = true;
    this.logger.info('trading engine started');
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  getRuntimeStatus(): Record<string, unknown> {
    const equity = this.equityUsd();
    const profitFactor = computeProfitFactor(this.paperMetrics.grossProfitUsd, this.paperMetrics.grossLossUsd);
    return {
      stage: this.rollout.getStage(),
      killSwitch: this.killSwitch.status(),
      cashUsd: this.cashUsd,
      equityUsd: equity,
      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd: this.unrealizedPnlUsd,
      drawdownPct: this.drawdownPct(equity),
      paperMetrics: {
        ...this.paperMetrics,
        winRate: this.paperMetrics.trades === 0 ? 0 : this.paperMetrics.wins / this.paperMetrics.trades,
        profitFactor,
      },
      tinyLiveRiskMultiplier: this.tinyLiveRiskMultiplier,
      backtestGate: {
        passed: this.backtestGatePassed,
        reason: this.backtestGateReason,
      },
      recentAlerts: this.alerts.slice(0, 20),
    };
  }

  getPaperWindowMetrics(): { trades: number; winRate: number; profitFactor: number; maxDrawdownPct: number; netPnlUsd: number } {
    const winRate = this.paperMetrics.trades === 0 ? 0 : this.paperMetrics.wins / this.paperMetrics.trades;
    const profitFactor = computeProfitFactor(this.paperMetrics.grossProfitUsd, this.paperMetrics.grossLossUsd);
    return {
      trades: this.paperMetrics.trades,
      winRate,
      profitFactor,
      maxDrawdownPct: this.paperMetrics.maxDrawdownPct,
      netPnlUsd: this.paperMetrics.netPnlUsd,
    };
  }

  emitExternalAlert(
    level: AlertEvent['level'],
    type: AlertEvent['type'],
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.raiseAlert(level, type, message, meta);
  }

  setBacktestGate(passed: boolean, reason: string): void {
    this.backtestGatePassed = passed;
    this.backtestGateReason = reason;
    const shouldBlockForBacktestGate = !passed && this.rollout.getStage() === 'tiny_live';
    if (shouldBlockForBacktestGate) {
      this.killSwitch.enable('backtest gate failed');
    } else if (this.killSwitch.status().reason === 'backtest gate failed') {
      this.killSwitch.disable();
    }
  }

  private async onCandle(candle: Candle): Promise<void> {
    if (!this.started) return;
    if (candle.timeframe !== '1m') {
      this.refreshUnrealized();
      return;
    }

    const shouldBlockForBacktestGate = !this.backtestGatePassed && this.rollout.getStage() === 'tiny_live';
    if (shouldBlockForBacktestGate) {
      if (!this.backtestAlerted) {
        this.raiseAlert('critical', 'risk_limit', `backtest gate failed: ${this.backtestGateReason}`, {});
        this.backtestAlerted = true;
      }
      this.snapshotEquity(candle.closeTime);
      return;
    }

    this.syncDay();
    this.refreshUnrealized();
    const signal = this.strategy.onCandle(candle);
    this.audit('signal_generated', {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      action: signal.action,
      strength: signal.strength,
      reason: signal.reason,
    });
    if (signal.symbol !== candle.symbol) {
      this.logger.warn('signal/candle symbol mismatch', {
        signalSymbol: signal.symbol,
        candleSymbol: candle.symbol,
      });
      this.snapshotEquity(candle.closeTime);
      return;
    }

    if (signal.action === 'hold') {
      this.snapshotEquity(candle.closeTime);
      return;
    }

    this.pruneOrderRateWindow();
    const equity = this.equityUsd();
    const riskDecision = this.risk.check(signal, {
      equityUsd: equity,
      peakEquityUsd: this.peakEquityUsd,
      dailyPnlUsd: this.realizedPnlUsd - this.dayRealizedBaseline,
      recentLossStreak: this.recentLossStreak,
      ordersLastMinute: this.orderTimes.length,
      killSwitch: this.killSwitch.status().enabled,
    });
    this.audit('risk_decision', {
      signal,
      allowed: riskDecision.allowed,
      reason: riskDecision.reason,
      maxSizeUsd: riskDecision.maxSizeUsd ?? null,
    });

    if (!riskDecision.allowed) {
      if (riskDecision.reason.includes('breached') || riskDecision.reason.includes('kill switch')) {
        this.raiseAlert('warning', 'risk_limit', `risk blocked signal: ${riskDecision.reason}`, { signal });
      }
      this.snapshotEquity(candle.closeTime);
      return;
    }

    const sizeUsd = (riskDecision.maxSizeUsd ?? 0) * Math.max(0.2, signal.strength);
    const qty = Number(((sizeUsd * this.getRiskMultiplier()) / candle.close).toFixed(6));
    if (!Number.isFinite(qty) || qty <= 0) {
      this.snapshotEquity(candle.closeTime);
      return;
    }

    const orderRequest = {
      symbol: signal.symbol,
      side: signal.action,
      quantity: qty,
      clientOrderId: randomUUID(),
      requestedAt: Date.now(),
      markPrice: candle.close,
      intent: this.rollout.getStage() === 'tiny_live' ? 'live' : 'paper',
    } as const;
    this.audit('order_submitted', {
      clientOrderId: orderRequest.clientOrderId,
      side: orderRequest.side,
      quantity: orderRequest.quantity,
      markPrice: orderRequest.markPrice,
      intent: orderRequest.intent,
    });

    try {
      const result = await this.orderManager.submit(orderRequest);
      this.audit('order_result', {
        clientOrderId: orderRequest.clientOrderId,
        orderId: result.orderId,
        status: result.status,
        reason: result.reason ?? null,
        filledQuantity: result.filledQuantity ?? 0,
        avgFillPrice: result.avgFillPrice ?? 0,
      });

      if (result.status !== 'accepted') {
        this.raiseAlert('warning', 'order_failure', `order rejected: ${result.reason ?? 'unknown'}`, {
          symbol: orderRequest.symbol,
          side: orderRequest.side,
          quantity: orderRequest.quantity,
        });
        this.snapshotEquity(candle.closeTime);
        return;
      }

      this.orderTimes.push(Date.now());
      this.consumeFillCashflow(orderRequest.side, result.avgFillPrice ?? candle.close, result.filledQuantity ?? qty, result.feesUsd ?? 0);
      this.realizedPnlUsd += result.realizedPnlUsd ?? 0;
      this.paperMetrics.netPnlUsd += (result.realizedPnlUsd ?? 0) - (result.feesUsd ?? 0);
      if ((result.realizedPnlUsd ?? 0) > 0) {
        this.paperMetrics.wins += 1;
        this.paperMetrics.grossProfitUsd += result.realizedPnlUsd ?? 0;
        this.recentLossStreak = 0;
      } else if ((result.realizedPnlUsd ?? 0) < 0) {
        this.paperMetrics.losses += 1;
        this.paperMetrics.grossLossUsd += Math.abs(result.realizedPnlUsd ?? 0);
        this.recentLossStreak += 1;
      }
      this.paperMetrics.trades += 1;
      this.refreshUnrealized();
      this.evaluateRollout();
      this.snapshotEquity(candle.closeTime);
    } catch (error) {
      this.raiseAlert('critical', 'order_failure', 'order manager exception', {
        error: String(error),
        signal,
      });
    }
  }

  private consumeFillCashflow(side: 'buy' | 'sell', price: number, quantity: number, fees: number): void {
    const gross = price * quantity;
    if (side === 'buy') {
      this.cashUsd -= gross + fees;
      return;
    }
    this.cashUsd += gross - fees;
  }

  private evaluateRollout(): void {
    const decision = this.rollout.evaluate(this.getPaperWindowMetrics());
    if (decision.stage === 'tiny_live' && this.canIncreaseTinyRisk()) {
      this.tinyLiveRiskMultiplier = Math.min(0.5, this.tinyLiveRiskMultiplier + 0.05);
    }
    if (decision.stage === 'paper') {
      this.tinyLiveRiskMultiplier = 0.1;
    }
    if (!decision.changed) return;
    this.audit('rollout_stage_change', {
      stage: decision.stage,
      reason: decision.reason,
    });
    this.logger.warn('rollout stage changed', { stage: decision.stage, reason: decision.reason });
  }

  private getRiskMultiplier(): number {
    if (this.rollout.getStage() === 'tiny_live') return this.tinyLiveRiskMultiplier;
    return 1;
  }

  private canIncreaseTinyRisk(): boolean {
    if (this.paperMetrics.trades < 20) return false;
    const recentPnlPositive = this.paperMetrics.netPnlUsd > 0;
    const profitFactor = computeProfitFactor(this.paperMetrics.grossProfitUsd, this.paperMetrics.grossLossUsd);
    return recentPnlPositive && profitFactor > 1.1 && this.paperMetrics.maxDrawdownPct < this.config.risk.maxDrawdownPct * 0.7;
  }

  private refreshUnrealized(): void {
    const positions = this.db.getPositions();
    let unrealized = 0;
    for (const position of positions) {
      const mark = this.feed.getLastPrice(position.symbol);
      if (!mark) continue;
      const pnl = position.quantity * (mark - position.avgPrice);
      unrealized += pnl;
      this.db.upsertPosition({
        ...position,
        unrealizedPnl: pnl,
        updatedAt: Date.now(),
      });
    }
    this.unrealizedPnlUsd = unrealized;
  }

  private pruneOrderRateWindow(): void {
    const threshold = Date.now() - 60_000;
    while (this.orderTimes.length > 0 && this.orderTimes[0] < threshold) {
      this.orderTimes.shift();
    }
  }

  private equityUsd(): number {
    return this.cashUsd + this.unrealizedPnlUsd;
  }

  private drawdownPct(equity: number): number {
    if (equity > this.peakEquityUsd) this.peakEquityUsd = equity;
    if (this.peakEquityUsd <= 0) return 0;
    return ((this.peakEquityUsd - equity) / this.peakEquityUsd) * 100;
  }

  private snapshotEquity(ts: number): void {
    const equity = this.equityUsd();
    const drawdown = this.drawdownPct(equity);
    this.paperMetrics.maxDrawdownPct = Math.max(this.paperMetrics.maxDrawdownPct, drawdown);

    const point: EquityPoint = {
      timestamp: ts,
      equityUsd: equity,
      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd: this.unrealizedPnlUsd,
      drawdownPct: drawdown,
    };
    this.db.insertEquityPoint(point);

    if (drawdown >= this.config.risk.maxDrawdownPct) {
      this.killSwitch.enable('max drawdown breached');
      this.raiseAlert('critical', 'drawdown_breach', `drawdown ${drawdown.toFixed(2)}% >= ${this.config.risk.maxDrawdownPct}%`, {
        equityUsd: equity,
      });
    }
  }

  private syncDay(): void {
    const next = this.currentDayKey();
    if (next === this.dayKey) return;
    this.dayKey = next;
    this.dayRealizedBaseline = this.realizedPnlUsd;
    this.recentLossStreak = 0;
  }

  private currentDayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private raiseAlert(
    level: AlertEvent['level'],
    type: AlertEvent['type'],
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const alert: AlertEvent = {
      id: randomUUID(),
      level,
      type,
      message,
      timestamp: Date.now(),
      meta,
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > 500) this.alerts.splice(500);
    this.db.insertAlert(alert);
    this.audit('alert', alert as unknown as Record<string, unknown>);
    this.logger.warn('alert', { type: alert.type, level: alert.level, message: alert.message });
  }

  private audit(type: AuditEvent['type'], payload: Record<string, unknown>): void {
    const event: AuditEvent = {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      payload,
    };
    this.db.insertAudit(event);
  }
}

const computeProfitFactor = (grossProfitUsd: number, grossLossUsd: number): number => {
  if (grossLossUsd === 0) {
    return grossProfitUsd > 0 ? 50 : 0;
  }
  return Math.min(50, grossProfitUsd / grossLossUsd);
};
