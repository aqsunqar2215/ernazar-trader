import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { TrainedModel } from './train.js';

export type ModelStage = 'champion' | 'challenger';

export interface RegisteredModel extends TrainedModel {
  stage: ModelStage;
  source: 'batch_training' | 'rl_offline_q_learning';
  evaluation: {
    walkForwardSharpe: number;
    walkForwardProfitFactor: number;
    walkForwardMaxDrawdown: number;
    paperWindowProfitFactor: number;
    paperWindowSharpe?: number;
    paperWindowNetPnl: number;
    paperWindowTrades?: number;
    unseenProfitFactor?: number;
    unseenSharpe?: number;
    unseenNetPnl?: number;
    unseenTrades?: number;
    inSampleWinRate?: number;
    inSampleNetPnl?: number;
  };
}

interface RegistryDocument {
  champion?: RegisteredModel;
  previousChampion?: RegisteredModel;
  challengers: RegisteredModel[];
}

export const computeModelScore = (evaluation: RegisteredModel['evaluation']): number =>
  evaluation.walkForwardSharpe * 0.5 +
  evaluation.paperWindowProfitFactor * 0.3 +
  (evaluation.paperWindowSharpe ?? 0) * 0.2;

export class ModelRegistry {
  private doc: RegistryDocument;

  constructor(private readonly path: string) {
    this.doc = this.load();
  }

  registerChallenger(model: RegisteredModel): void {
    this.doc.challengers.unshift(model);
    this.doc.challengers = this.doc.challengers.slice(0, 20);
    this.save();
  }

  getChampion(): RegisteredModel | undefined {
    return this.doc.champion;
  }

  getPreviousChampion(): RegisteredModel | undefined {
    return this.doc.previousChampion;
  }

  getChallengers(): RegisteredModel[] {
    return [...this.doc.challengers];
  }

  reload(): void {
    this.doc = this.load();
  }

  evaluatePromotion(params: {
    challengerId: string;
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
    enforceUnseenGate: boolean;
    minUnseenProfitFactor: number;
    minUnseenSharpe: number;
    minUnseenTrades: number;
  }): { promoted: boolean; reason: string; champion?: RegisteredModel } {
    const challenger = this.doc.challengers.find(item => item.id === params.challengerId);
    if (!challenger) {
      return { promoted: false, reason: 'challenger not found' };
    }

    const inSampleWinRate = challenger.evaluation.inSampleWinRate;
    const inSampleNetPnl = challenger.evaluation.inSampleNetPnl;
    const isRlChallenger = challenger.kind === 'rl_linear_q';
    const canUseSimplePromotion = params.simplePromotionEnabled && (!isRlChallenger || params.simplePromotionAllowRl);
    const simpleGateSkippedForRl =
      params.simplePromotionEnabled &&
      isRlChallenger &&
      !params.simplePromotionAllowRl;
    const withSimpleGateContext = (reason: string): string =>
      simpleGateSkippedForRl ? `${reason}; simple gate disabled for RL (using OOS gates)` : reason;
    const inSamplePassesSimpleGate =
      canUseSimplePromotion &&
      Number.isFinite(inSampleWinRate) &&
      Number.isFinite(inSampleNetPnl) &&
      (inSampleWinRate as number) > params.simplePromotionMinWinRate &&
      (inSampleNetPnl as number) > params.simplePromotionMinNetPnl;

    if (challenger.evaluation.walkForwardSharpe < params.minWalkForwardSharpe) {
      return {
        promoted: false,
        reason: withSimpleGateContext(
          `walk-forward sharpe below threshold (${challenger.evaluation.walkForwardSharpe.toFixed(4)} < ${params.minWalkForwardSharpe.toFixed(4)})`,
        ),
      };
    }
    if (challenger.evaluation.walkForwardProfitFactor < params.minWalkForwardProfitFactor) {
      return {
        promoted: false,
        reason: withSimpleGateContext(
          `walk-forward profit factor below threshold (${challenger.evaluation.walkForwardProfitFactor.toFixed(4)} < ${params.minWalkForwardProfitFactor.toFixed(4)})`,
        ),
      };
    }
    if (challenger.evaluation.walkForwardMaxDrawdown > params.maxWalkForwardDrawdown) {
      return {
        promoted: false,
        reason: withSimpleGateContext(
          `walk-forward max drawdown above threshold (${challenger.evaluation.walkForwardMaxDrawdown.toFixed(4)} > ${params.maxWalkForwardDrawdown.toFixed(4)})`,
        ),
      };
    }
    const paperTrades = challenger.evaluation.paperWindowTrades ?? 0;
    if (paperTrades < params.minPaperTrades) {
      return {
        promoted: false,
        reason: withSimpleGateContext(`insufficient paper data (${paperTrades} < ${params.minPaperTrades} trades)`),
      };
    }
    if (challenger.evaluation.paperWindowProfitFactor < params.minPaperProfitFactor) {
      return {
        promoted: false,
        reason: withSimpleGateContext(
          `paper window profit factor below threshold (${challenger.evaluation.paperWindowProfitFactor.toFixed(4)} < ${params.minPaperProfitFactor.toFixed(4)})`,
        ),
      };
    }
    const paperSharpe = challenger.evaluation.paperWindowSharpe ?? 0;
    if (paperSharpe < params.minPaperSharpe) {
      return {
        promoted: false,
        reason: withSimpleGateContext(
          `paper window sharpe below threshold (${paperSharpe.toFixed(4)} < ${params.minPaperSharpe.toFixed(4)})`,
        ),
      };
    }
    if (params.enforceUnseenGate) {
      const unseenTrades = challenger.evaluation.unseenTrades ?? 0;
      if (unseenTrades < params.minUnseenTrades) {
        return {
          promoted: false,
          reason: withSimpleGateContext(`insufficient unseen data (${unseenTrades} < ${params.minUnseenTrades} trades)`),
        };
      }
      const unseenProfitFactor = challenger.evaluation.unseenProfitFactor ?? 0;
      if (unseenProfitFactor < params.minUnseenProfitFactor) {
        return {
          promoted: false,
          reason: withSimpleGateContext(
            `unseen profit factor below threshold (${unseenProfitFactor.toFixed(4)} < ${params.minUnseenProfitFactor.toFixed(4)})`,
          ),
        };
      }
      const unseenSharpe = challenger.evaluation.unseenSharpe ?? 0;
      if (unseenSharpe < params.minUnseenSharpe) {
        return {
          promoted: false,
          reason: withSimpleGateContext(
            `unseen sharpe below threshold (${unseenSharpe.toFixed(4)} < ${params.minUnseenSharpe.toFixed(4)})`,
          ),
        };
      }
    }

    const current = this.doc.champion;
    if (current) {
      const challengerScore = computeModelScore(challenger.evaluation);
      const currentScore = computeModelScore(current.evaluation);
      if (challengerScore <= currentScore) {
        return {
          promoted: false,
          reason: withSimpleGateContext(
            `challenger score (${challengerScore.toFixed(4)}) not better than champion (${currentScore.toFixed(4)}). ` +
              `Challenger: wfSh=${challenger.evaluation.walkForwardSharpe.toFixed(4)}, ` +
              `paperPF=${challenger.evaluation.paperWindowProfitFactor.toFixed(2)}, ` +
              `paperSh=${(challenger.evaluation.paperWindowSharpe ?? 0).toFixed(4)}. ` +
              `Champion: wfSh=${current.evaluation.walkForwardSharpe.toFixed(4)}, ` +
              `paperPF=${current.evaluation.paperWindowProfitFactor.toFixed(2)}, ` +
              `paperSh=${(current.evaluation.paperWindowSharpe ?? 0).toFixed(4)}`,
          ),
          champion: current,
        };
      }
    }

    if (!current && inSamplePassesSimpleGate) {
      return this.promoteChallenger(challenger, 'simple promotion gate passed (winRate/netPnl)');
    }

    return this.promoteChallenger(
      challenger,
      withSimpleGateContext('challenger promoted to champion'),
    );
  }

  private promoteChallenger(challenger: RegisteredModel, reason: string): { promoted: boolean; reason: string; champion?: RegisteredModel } {
    const current = this.doc.champion;
    this.doc.previousChampion = current ? { ...current, stage: 'champion' } : undefined;
    this.doc.champion = { ...challenger, stage: 'champion' };
    this.doc.challengers = this.doc.challengers.filter(item => item.id !== challenger.id);
    this.save();
    return { promoted: true, reason, champion: this.doc.champion };
  }

  rollbackToPreviousChampion(): { rolledBack: boolean; reason: string; champion?: RegisteredModel } {
    const previous = this.doc.previousChampion;
    if (!previous) {
      return { rolledBack: false, reason: 'previous champion not found', champion: this.doc.champion };
    }
    const current = this.doc.champion;
    if (current) {
      this.doc.challengers = [current, ...this.doc.challengers]
        .filter((item, idx, arr) => arr.findIndex(other => other.id === item.id) === idx)
        .slice(0, 20);
    }
    this.doc.champion = { ...previous, stage: 'champion' };
    this.doc.previousChampion = undefined;
    this.save();
    return { rolledBack: true, reason: 'rolled back to previous champion', champion: this.doc.champion };
  }

  private load(): RegistryDocument {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      return { challengers: [] };
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryDocument;
      return {
        champion: parsed.champion,
        previousChampion: parsed.previousChampion,
        challengers: parsed.challengers ?? [],
      };
    } catch {
      return { challengers: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.doc, null, 2), 'utf8');
  }
}
