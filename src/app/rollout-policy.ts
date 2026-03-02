export type RolloutStage = 'paper' | 'tiny_live';

export interface PaperWindowMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  netPnlUsd: number;
}

export interface RolloutPolicyConfig {
  requestedMode: RolloutStage;
  minTradesForTinyLive: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
}

export class RolloutPolicy {
  private stage: RolloutStage = 'paper';

  constructor(private readonly config: RolloutPolicyConfig) {}

  evaluate(
    metrics: PaperWindowMetrics,
    gates?: { paperSanityPassed?: boolean; shadowGatePassed?: boolean },
  ): { stage: RolloutStage; reason: string; changed: boolean } {
    const previous = this.stage;
    if (this.config.requestedMode === 'paper') {
      this.stage = 'paper';
      return { stage: this.stage, reason: 'rollout mode pinned to paper', changed: previous !== this.stage };
    }

    const paperSanityPassed = gates?.paperSanityPassed ?? true;
    if (!paperSanityPassed) {
      this.stage = 'paper';
      return { stage: this.stage, reason: 'paper sanity gate failed', changed: previous !== this.stage };
    }

    const shadowGatePassed = gates?.shadowGatePassed ?? true;
    if (!shadowGatePassed) {
      this.stage = 'paper';
      return { stage: this.stage, reason: 'shadow gate blocked tiny-live', changed: previous !== this.stage };
    }

    const passed =
      metrics.trades >= this.config.minTradesForTinyLive &&
      metrics.profitFactor >= this.config.minProfitFactor &&
      metrics.maxDrawdownPct <= this.config.maxDrawdownPct;

    this.stage = passed ? 'tiny_live' : 'paper';
    const reason = passed ? 'paper window passed, tiny-live allowed' : 'paper metrics below rollout threshold';
    return { stage: this.stage, reason, changed: previous !== this.stage };
  }

  getStage(): RolloutStage {
    return this.stage;
  }
}
