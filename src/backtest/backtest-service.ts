import type { AppConfig } from '../core/config.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { BacktestEngine } from './engine.js';
import { WalkForwardValidator } from './walk-forward.js';
import { MomentumMeanReversionStrategy } from '../strategy/momentum-mean-reversion.js';

export class BacktestService {
  private readonly logger: Logger;
  private readonly backtest = new BacktestEngine(() => new MomentumMeanReversionStrategy());
  private readonly walkForward = new WalkForwardValidator(this.backtest);
  private lastResult: Record<string, unknown> | null = null;
  private passedGate = false;
  private gateReason = 'not executed';

  constructor(
    private readonly db: StateDb,
    logger: Logger,
    private readonly config: AppConfig,
  ) {
    this.logger = logger.child('backtest');
  }

  runLatest(): { passed: boolean; reason: string; result: Record<string, unknown> } {
    const candles = this.db.getRecentCandles(40_000).filter(item => item.timeframe === '1m');
    const backtest = this.backtest.run(candles, {
      initialCapitalUsd: this.config.execution.initialEquityUsd,
      feeBps: this.config.execution.feeBps,
      slippageBps: this.config.execution.slippageBps,
      latencyBars: 1,
      riskPerTradePct: this.config.risk.maxRiskPerTradePct,
    });
    const wf = this.walkForward.validate(candles, {
      initialCapitalUsd: this.config.execution.initialEquityUsd,
      feeBps: this.config.execution.feeBps,
      slippageBps: this.config.execution.slippageBps,
      latencyBars: 1,
      riskPerTradePct: this.config.risk.maxRiskPerTradePct,
    });

    const passed =
      backtest.profitFactor >= this.config.ml.minPaperProfitFactor &&
      wf.avgSharpe >= this.config.ml.minWalkForwardSharpe &&
      backtest.maxDrawdown <= this.config.risk.maxDrawdownPct / 100;

    const reason = passed
      ? 'strategy passed backtest + walk-forward gate'
      : 'failed gate (profitFactor/sharpe/drawdown)';

    this.lastResult = {
      backtest,
      walkForward: wf,
      gate: {
        passed,
        reason,
      },
    };
    this.passedGate = passed;
    this.gateReason = reason;
    this.logger.info('backtest run completed', {
      passed,
      reason,
      netPnl: backtest.netPnl,
      profitFactor: backtest.profitFactor,
      sharpe: wf.avgSharpe,
      maxDrawdown: backtest.maxDrawdown,
      maxDrawdownPct: backtest.maxDrawdown * 100,
    });
    return { passed, reason, result: this.lastResult };
  }

  getGateStatus(): { passed: boolean; reason: string } {
    return { passed: this.passedGate, reason: this.gateReason };
  }

  getLastResult(): Record<string, unknown> | null {
    return this.lastResult;
  }
}
