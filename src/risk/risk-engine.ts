import type { RiskDecision, Signal } from '../core/types.js';

export interface RiskState {
  equityUsd: number;
  peakEquityUsd: number;
  dailyPnlUsd: number;
  recentLossStreak: number;
  lossCooldownUntilMs: number;
  nowMs: number;
  ordersLastMinute: number;
  turnoverLastHour: number;
  turnoverForSignal: number;
  killSwitch: boolean;
}

export interface RiskLimits {
  maxRiskPerTradePct: number;
  maxDailyLossUsd: number;
  maxDrawdownPct: number;
  maxOrdersPerMinute: number;
  maxTurnoverPerHour: number;
}

export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {}

  check(signal: Signal, state: RiskState): RiskDecision {
    if (signal.action === 'hold') {
      return { allowed: false, reason: 'hold signal' };
    }
    if (state.killSwitch) {
      return { allowed: false, reason: 'kill switch enabled' };
    }
    if (Math.abs(state.dailyPnlUsd) >= this.limits.maxDailyLossUsd && state.dailyPnlUsd < 0) {
      return { allowed: false, reason: 'daily loss limit breached' };
    }

    const drawdownPct = ((state.peakEquityUsd - state.equityUsd) / state.peakEquityUsd) * 100;
    if (drawdownPct >= this.limits.maxDrawdownPct) {
      return { allowed: false, reason: 'max drawdown breached' };
    }
    if (state.ordersLastMinute >= this.limits.maxOrdersPerMinute) {
      return { allowed: false, reason: 'max orders per minute breached' };
    }
    if (this.limits.maxTurnoverPerHour > 0 && state.turnoverLastHour + state.turnoverForSignal > this.limits.maxTurnoverPerHour) {
      return { allowed: false, reason: 'max turnover per hour breached' };
    }
    if (state.lossCooldownUntilMs > state.nowMs) {
      return { allowed: false, reason: 'cooldown after loss streak' };
    }

    return {
      allowed: true,
      reason: 'risk checks passed',
      maxSizeUsd: (state.equityUsd * this.limits.maxRiskPerTradePct) / 100,
    };
  }
}
