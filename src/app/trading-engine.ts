import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../core/config.js';
import type { AlertEvent, AuditEvent, Candle, EquityPoint, ShadowGateStatus, Signal } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { MarketDataFeed } from '../market/market-feed.js';
import { OrderManager } from '../execution/order-manager.js';
import { RiskEngine } from '../risk/risk-engine.js';
import { KillSwitch } from '../risk/kill-switch.js';
import type { Strategy } from '../strategy/strategy.js';
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

interface ExecutionGuardState {
  step: number;
  position: -1 | 0 | 1;
  positionEntryStep: number;
  lastTurnoverStep: number;
  lastFlipStep: number;
}

interface PaperSanityStatus {
  passed: boolean;
  reason: string;
  netPnlUsd: number;
  maxDrawdownPct: number;
  criticalAlertsCount: number;
}

export class TradingEngine {
  private readonly logger: Logger;
  private readonly strategy: Strategy;
  private readonly risk: RiskEngine;
  private readonly killSwitch = new KillSwitch();
  private readonly rollout: RolloutPolicy;
  private readonly orderTimes: number[] = [];
  private readonly turnoverEvents: Array<{ ts: number; units: number }> = [];
  private candleQueue: Promise<void> = Promise.resolve();
  private started = false;
  private cashUsd: number;
  private realizedPnlUsd = 0;
  private unrealizedPnlUsd = 0;
  private peakEquityUsd: number;
  private dayRealizedBaseline = 0;
  private dayKey = this.currentDayKey();
  private recentLossStreak = 0;
  private lossCooldownUntilMs = 0;
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
  private readonly executionGuards = new Map<string, ExecutionGuardState>();
  private rlExecutionGuards = {
    confidence: 0,
    minHold: 0,
    flipCooldown: 0,
    lowStrength: 0,
    confidenceTriggered: 0,
    actionsBeforeGuards: 0,
    actionsAfterGuards: 0,
  };
  private rlQGapSamples: number[] = [];
  private shadowGateStatus: ShadowGateStatus = { passed: false, reason: 'not evaluated' };
  private paperSanityStatus: PaperSanityStatus = { passed: true, reason: 'not evaluated', netPnlUsd: 0, maxDrawdownPct: 0, criticalAlertsCount: 0 };
  private runtimeStartedAt = Date.now();

  constructor(
    private readonly db: StateDb,
    private readonly feed: MarketDataFeed,
    private readonly orderManager: OrderManager,
    strategy: Strategy,
    logger: Logger,
    private readonly config: AppConfig,
  ) {
    this.logger = logger.child('trading-engine');
    this.strategy = strategy;
    this.cashUsd = config.execution.initialEquityUsd;
    this.peakEquityUsd = config.execution.initialEquityUsd;
    this.risk = new RiskEngine({
      maxRiskPerTradePct: config.risk.maxRiskPerTradePct,
      maxDailyLossUsd: config.risk.maxDailyLossUsd,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      maxOrdersPerMinute: config.risk.maxOrdersPerMinute,
      maxTurnoverPerHour: config.risk.maxTurnoverPerHour,
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
    this.runtimeStartedAt = Date.now();
    await this.orderManager.reconcile();
    this.feed.on('candle', (candle: Candle) => {
      this.candleQueue = this.candleQueue
        .catch(error => {
          this.logger.error('onCandle queue error', { error: String(error) });
        })
        .then(() => this.onCandle(candle));
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
      paperSanity: this.paperSanityStatus,
      backtestGate: {
        passed: this.backtestGatePassed,
        reason: this.backtestGateReason,
      },
      shadowGate: this.shadowGateStatus,
      rlExecutionGuards: {
        ...this.rlExecutionGuards,
        confidenceGateEnabled: this.config.rl.confidenceGateEnabled,
        confidenceQGap: this.config.rl.confidenceQGap,
        effectiveConfidenceQGap: this.resolveConfidenceQGapThreshold(),
        confidenceQGapAdaptiveEnabled: this.config.rl.confidenceQGapAdaptiveEnabled,
        confidenceQGapAdaptiveQuantile: this.config.rl.confidenceQGapAdaptiveQuantile,
        confidenceQGapAdaptiveScale: this.config.rl.confidenceQGapAdaptiveScale,
        confidenceQGapMin: this.config.rl.confidenceQGapMin,
        minSignalStrength: this.config.rl.minSignalStrength,
        holdFlattenEnabled: this.config.rl.holdFlattenEnabled,
        minHoldBars: this.config.rl.minHoldBars,
        flipCooldownBars: this.config.rl.flipCooldownBars,
        maxPositionBars: this.config.rl.maxPositionBars,
      },
      lossStreakCooldown: {
        active: this.lossCooldownUntilMs > Date.now(),
        remainingMs: Math.max(0, this.lossCooldownUntilMs - Date.now()),
        recentLossStreak: this.recentLossStreak,
        streakThreshold: this.config.risk.cooldownLossStreak,
        cooldownMinutes: this.config.risk.cooldownLossMinutes,
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

  setShadowGate(status: ShadowGateStatus): void {
    this.shadowGateStatus = status;
  }

  private async onCandle(candle: Candle): Promise<void> {
    if (!this.started) return;
    if (candle.timeframe !== '1m') {
      this.refreshUnrealized();
      return;
    }
    const guard = this.updateExecutionGuard(candle);

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

    const currentPosition = this.positionSide(signal.symbol);
    const positionAgeBars = currentPosition === 0 ? 0 : Math.max(0, guard.step - guard.positionEntryStep);
    const flattenOnRlHold =
      signal.policy === 'rl' &&
      this.config.rl.holdFlattenEnabled &&
      signal.action === 'hold' &&
      currentPosition !== 0 &&
      signal.strength >= this.config.rl.minSignalStrength;
    const flattenOnMaxAge =
      signal.policy === 'rl' &&
      currentPosition !== 0 &&
      this.config.rl.maxPositionBars > 0 &&
      positionAgeBars >= this.config.rl.maxPositionBars;
    const forceFlatten = flattenOnRlHold || flattenOnMaxAge;
    if (signal.action === 'hold' && !forceFlatten) {
      this.snapshotEquity(candle.closeTime);
      return;
    }
    const executionSide: 'buy' | 'sell' = forceFlatten
      ? currentPosition > 0 ? 'sell' : 'buy'
      : signal.action === 'buy' ? 'buy' : 'sell';

    const isRlSignal = signal.policy === 'rl';
    let rlGuardDecision: { allowed: boolean; reason: string; turnover: number } | null = null;
    if (isRlSignal && !forceFlatten) {
      rlGuardDecision = this.applyRlExecutionGuards(signal, guard);
      if (!rlGuardDecision.allowed) {
        this.audit('rl_execution_guard_blocked', {
          symbol: signal.symbol,
          action: signal.action,
          reason: rlGuardDecision.reason,
          turnover: rlGuardDecision.turnover,
          qGap: signal.qGap ?? null,
        });
        this.snapshotEquity(candle.closeTime);
        return;
      }
    }

    this.pruneOrderRateWindow();
    this.pruneTurnoverWindow();
    const equity = this.equityUsd();
    const desiredPosition = forceFlatten ? 0 : executionSide === 'buy' ? 1 : -1;
    const turnoverForSignal = forceFlatten
      ? Math.abs(currentPosition)
      : rlGuardDecision?.turnover ?? Math.abs(desiredPosition - currentPosition);
    const turnoverLastHour = this.turnoverEvents.reduce((sum, item) => sum + item.units, 0);
    const nowMs = Date.now();
    if (this.lossCooldownUntilMs > 0 && nowMs >= this.lossCooldownUntilMs) {
      this.lossCooldownUntilMs = 0;
    }
    const riskDecision = forceFlatten
      ? { allowed: true, reason: flattenOnMaxAge ? 'rl max age flatten' : 'rl hold flatten' }
      : this.risk.check(signal, {
        equityUsd: equity,
        peakEquityUsd: this.peakEquityUsd,
        dailyPnlUsd: this.realizedPnlUsd - this.dayRealizedBaseline,
        recentLossStreak: this.recentLossStreak,
        lossCooldownUntilMs: this.lossCooldownUntilMs,
        nowMs,
        ordersLastMinute: this.orderTimes.length,
        turnoverLastHour,
        turnoverForSignal,
        killSwitch: this.killSwitch.status().enabled,
      });
    this.audit('risk_decision', {
      signal,
      allowed: riskDecision.allowed,
      reason: riskDecision.reason,
      maxSizeUsd: riskDecision.maxSizeUsd ?? null,
      turnoverLastHour,
      turnoverForSignal,
    });

    if (!riskDecision.allowed) {
      if (riskDecision.reason.includes('breached') || riskDecision.reason.includes('kill switch')) {
        this.raiseAlert('warning', 'risk_limit', `risk blocked signal: ${riskDecision.reason}`, { signal });
      }
      this.snapshotEquity(candle.closeTime);
      return;
    }

    const qty = forceFlatten
      ? Number(Math.abs(this.lookupPositionQuantity(signal.symbol)).toFixed(6))
      : Number((((riskDecision.maxSizeUsd ?? 0) * Math.max(0.2, signal.strength) * this.getRiskMultiplier()) / candle.close).toFixed(6));
    if (!Number.isFinite(qty) || qty <= 0) {
      this.snapshotEquity(candle.closeTime);
      return;
    }

    const orderRequest = {
      symbol: signal.symbol,
      side: executionSide,
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

      if (result.status === 'rejected' || result.status === 'canceled' || result.status === 'pending') {
        this.raiseAlert('warning', 'order_failure', `order rejected: ${result.reason ?? 'unknown'}`, {
          symbol: orderRequest.symbol,
          side: orderRequest.side,
          quantity: orderRequest.quantity,
        });
        this.snapshotEquity(candle.closeTime);
        return;
      }

      const filledQuantity = result.filledQuantity ?? 0;
      if (filledQuantity <= 0) {
        this.snapshotEquity(candle.closeTime);
        return;
      }

      const feesUsd = result.feesUsd ?? 0;
      const realizedPnlUsd = result.realizedPnlUsd ?? 0;
      const netTradePnlUsd = realizedPnlUsd - feesUsd;
      this.orderTimes.push(Date.now());
      if (turnoverForSignal > 0) {
        this.turnoverEvents.push({ ts: Date.now(), units: turnoverForSignal });
      }
      this.consumeFillCashflow(orderRequest.side, result.avgFillPrice ?? candle.close, filledQuantity, feesUsd);
      this.realizedPnlUsd += netTradePnlUsd;
      this.paperMetrics.netPnlUsd += netTradePnlUsd;
      if (netTradePnlUsd > 0) {
        this.paperMetrics.wins += 1;
        this.paperMetrics.grossProfitUsd += netTradePnlUsd;
        this.recentLossStreak = 0;
        this.lossCooldownUntilMs = 0;
      } else if (netTradePnlUsd < 0) {
        this.paperMetrics.losses += 1;
        this.paperMetrics.grossLossUsd += Math.abs(netTradePnlUsd);
        this.recentLossStreak += 1;
        this.activateLossStreakCooldown();
      }
      this.paperMetrics.trades += 1;
      this.refreshUnrealized();
      this.syncExecutionGuardPosition(signal.symbol, guard);
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
    const paperSanity = this.computePaperSanity();
    this.paperSanityStatus = paperSanity;
    const decision = this.rollout.evaluate(this.getPaperWindowMetrics(), {
      paperSanityPassed: paperSanity.passed,
      shadowGatePassed: this.shadowGateStatus.passed,
    });
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

  private pruneTurnoverWindow(): void {
    const threshold = Date.now() - 3_600_000;
    while (this.turnoverEvents.length > 0 && this.turnoverEvents[0].ts < threshold) {
      this.turnoverEvents.shift();
    }
  }

  private positionSide(symbol: string): -1 | 0 | 1 {
    const position = this.db.getPositions().find(item => item.symbol === symbol);
    if (!position) return 0;
    if (position.quantity > 0) return 1;
    if (position.quantity < 0) return -1;
    return 0;
  }

  private lookupPositionQuantity(symbol: string): number {
    const position = this.db.getPositions().find(item => item.symbol === symbol);
    return position?.quantity ?? 0;
  }

  private getOrCreateExecutionGuard(symbol: string): ExecutionGuardState {
    const existing = this.executionGuards.get(symbol);
    if (existing) return existing;
    const guard: ExecutionGuardState = {
      step: 0,
      position: 0,
      positionEntryStep: 0,
      lastTurnoverStep: 0,
      lastFlipStep: 0,
    };
    this.executionGuards.set(symbol, guard);
    return guard;
  }

  private updateExecutionGuard(candle: Candle): ExecutionGuardState {
    const guard = this.getOrCreateExecutionGuard(candle.symbol);
    guard.step += 1;
    this.syncExecutionGuardPosition(candle.symbol, guard);
    return guard;
  }

  private syncExecutionGuardPosition(symbol: string, guard?: ExecutionGuardState): void {
    const state = guard ?? this.executionGuards.get(symbol);
    if (!state) return;
    const dbPosition = this.positionSide(symbol);
    if (dbPosition === state.position) return;
    const prev = state.position;
    state.position = dbPosition;
    state.positionEntryStep = state.step;
    state.lastTurnoverStep = state.step;
    if (Math.abs(prev - dbPosition) === 2) {
      state.lastFlipStep = state.step;
    }
  }

  private applyRlExecutionGuards(signal: Signal, guard: ExecutionGuardState): { allowed: boolean; reason: string; turnover: number } {
    const desiredPosition = signal.action === 'buy' ? 1 : -1;
    const turnover = Math.abs(desiredPosition - guard.position);
    if (turnover <= 0) {
      return { allowed: false, reason: 'rl no-op', turnover };
    }
    this.rlExecutionGuards.actionsBeforeGuards += 1;
    this.recordRlQGapSample(signal.qGap);

    if (guard.position === 0 && signal.strength < this.config.rl.minSignalStrength) {
      this.rlExecutionGuards.lowStrength += 1;
      return { allowed: false, reason: 'rl low strength', turnover };
    }

    const positionAge = guard.position === 0 ? 0 : Math.max(0, guard.step - guard.positionEntryStep);
    const minHold = Math.max(0, Math.floor(this.config.rl.minHoldBars));
    if (guard.position !== 0 && positionAge < minHold) {
      this.rlExecutionGuards.minHold += 1;
      return { allowed: false, reason: 'rl min hold', turnover };
    }

    const flipCooldown = Math.max(0, Math.floor(this.config.rl.flipCooldownBars));
    if (guard.lastFlipStep > 0 && guard.step - guard.lastFlipStep < flipCooldown) {
      this.rlExecutionGuards.flipCooldown += 1;
      return { allowed: false, reason: 'rl flip cooldown', turnover };
    }

    const qGap = typeof signal.qGap === 'number' ? signal.qGap : Number.NaN;
    const confidenceQGap = this.resolveConfidenceQGapThreshold();
    const confidenceGateTriggered =
      this.config.rl.confidenceGateEnabled &&
      Number.isFinite(qGap) &&
      qGap < confidenceQGap;
    if (confidenceGateTriggered) {
      this.rlExecutionGuards.confidenceTriggered += 1;
      this.rlExecutionGuards.confidence += 1;
      return { allowed: false, reason: 'rl confidence gate', turnover };
    }

    this.rlExecutionGuards.actionsAfterGuards += 1;
    return { allowed: true, reason: 'rl execution guard pass', turnover };
  }

  private recordRlQGapSample(value: number | undefined): void {
    if (!Number.isFinite(value)) return;
    this.rlQGapSamples.push(value as number);
    if (this.rlQGapSamples.length > 2000) {
      this.rlQGapSamples.splice(0, this.rlQGapSamples.length - 2000);
    }
  }

  private resolveConfidenceQGapThreshold(): number {
    const base = Math.max(0, this.config.rl.confidenceQGap);
    if (!this.config.rl.confidenceQGapAdaptiveEnabled) return base;
    const minThreshold = Math.max(0, this.config.rl.confidenceQGapMin);
    if (this.rlQGapSamples.length < 12) {
      const warmupThreshold = base * 0.35;
      return clamp(warmupThreshold, minThreshold, base);
    }

    const sorted = [...this.rlQGapSamples].sort((a, b) => a - b);
    const quantile = clamp(this.config.rl.confidenceQGapAdaptiveQuantile, 0.35, 0.95);
    const idx = Math.floor((sorted.length - 1) * quantile);
    const qValue = sorted[Math.max(0, Math.min(sorted.length - 1, idx))] ?? base;
    const scaled = qValue * Math.max(0.1, this.config.rl.confidenceQGapAdaptiveScale);
    const adaptive = Math.max(minThreshold, scaled);
    let threshold = Math.min(base, adaptive);

    const before = this.rlExecutionGuards.actionsBeforeGuards;
    if (before >= 20) {
      const passRate = this.rlExecutionGuards.actionsAfterGuards / Math.max(1, before);
      const targetPassRate = 0.2;
      if (passRate < targetPassRate) {
        const relaxFactor = Math.max(0.2, passRate / targetPassRate);
        threshold *= relaxFactor;
      }
    }

    return clamp(threshold, minThreshold, base);
  }

  private computePaperSanity(): PaperSanityStatus {
    const netPnlUsd = this.realizedPnlUsd + this.unrealizedPnlUsd;
    const currentEquity = this.equityUsd();
    const peakForCalc = Math.max(this.peakEquityUsd, currentEquity);
    const currentDrawdownPct = peakForCalc <= 0 ? 0 : ((peakForCalc - currentEquity) / peakForCalc) * 100;
    const maxDrawdownPct = Math.max(this.paperMetrics.maxDrawdownPct, currentDrawdownPct);
    const criticalAlerts = this.alerts.filter(alert =>
      alert.level === 'critical' && alert.timestamp >= this.runtimeStartedAt,
    );
    const minNetPnlUsd = this.config.rollout.paperSanityMinNetPnlUsd;
    const maxDrawdownLimitRaw = this.config.rollout.paperSanityMaxDrawdownPct;
    const maxDrawdownLimit = maxDrawdownLimitRaw > 1 ? maxDrawdownLimitRaw : maxDrawdownLimitRaw * 100;
    const minTradesBeforeNetPnlGate = 12;
    const netPnlGateActive = this.paperMetrics.trades >= minTradesBeforeNetPnlGate;
    const netPnlPassed = !netPnlGateActive || netPnlUsd >= minNetPnlUsd;
    const passed = netPnlPassed && maxDrawdownPct <= maxDrawdownLimit && criticalAlerts.length === 0;
    const reason = passed
      ? 'ok'
      : criticalAlerts.length > 0
        ? 'critical_alerts'
        : maxDrawdownPct > maxDrawdownLimit
          ? 'max_drawdown'
          : 'net_pnl';
    return {
      passed,
      reason,
      netPnlUsd,
      maxDrawdownPct,
      criticalAlertsCount: criticalAlerts.length,
    };
  }

  private equityUsd(): number {
    return this.cashUsd + this.positionMarketValueUsd();
  }

  private positionMarketValueUsd(): number {
    const positions = this.db.getPositions();
    let value = 0;
    for (const position of positions) {
      const mark = this.feed.getLastPrice(position.symbol);
      if (!mark) continue;
      value += position.quantity * mark;
    }
    return value;
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
    this.lossCooldownUntilMs = 0;
  }

  private activateLossStreakCooldown(): void {
    if (this.config.risk.cooldownLossStreak <= 0 || this.config.risk.cooldownLossMinutes <= 0) return;
    if (this.recentLossStreak < this.config.risk.cooldownLossStreak) return;
    const nowMs = Date.now();
    if (this.lossCooldownUntilMs > nowMs) return;
    const cooldownMs = Math.floor(this.config.risk.cooldownLossMinutes * 60_000);
    if (cooldownMs <= 0) return;
    this.lossCooldownUntilMs = nowMs + cooldownMs;
    this.raiseAlert('warning', 'risk_limit', 'loss streak cooldown enabled', {
      recentLossStreak: this.recentLossStreak,
      cooldownLossStreak: this.config.risk.cooldownLossStreak,
      cooldownLossMinutes: this.config.risk.cooldownLossMinutes,
    });
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

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
