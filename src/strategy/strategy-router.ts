import type { Candle, Signal } from '../core/types.js';
import type { Strategy } from './strategy.js';
import type { AppConfig } from '../core/config.js';
import type { RegisteredModel } from '../ml/model-registry.js';
import type { RlLinearQPolicyModel } from '../ml/rl-policy.js';
import type { TrainedModel } from '../ml/train.js';
import { MlService } from '../ml/ml-service.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { MomentumMeanReversionStrategy } from './momentum-mean-reversion.js';
import { SupervisedLinearStrategy } from './supervised-linear.js';
import { RlPolicyStrategy } from './rl-policy-strategy.js';

type StrategyKind = 'momentum' | 'supervised' | 'rl';

export class StrategyRouter implements Strategy {
  private readonly logger: Logger;
  private readonly momentum = new MomentumMeanReversionStrategy();
  private supervised?: { id: string; strategy: SupervisedLinearStrategy };
  private rl?: { id: string; strategy: RlPolicyStrategy };
  private lastSelected: StrategyKind | null = null;

  constructor(
    private readonly db: StateDb,
    private readonly mlService: MlService,
    logger: Logger,
    private readonly config: AppConfig,
  ) {
    this.logger = logger.child('strategy-router');
  }

  onCandle(candle: Candle): Signal {
    this.refreshStrategies();
    const pick = this.pickStrategy();
    if (pick !== this.lastSelected) {
      this.lastSelected = pick;
      this.logger.info('strategy routed', { strategy: pick });
    }
    switch (pick) {
      case 'rl':
        return this.rl?.strategy.onCandle(candle) ?? this.momentum.onCandle(candle);
      case 'supervised':
        return this.supervised?.strategy.onCandle(candle) ?? this.momentum.onCandle(candle);
      default:
        return this.momentum.onCandle(candle);
    }
  }

  private refreshStrategies(): void {
    const { champion } = this.mlService.getRegistrySnapshot();
    const rlChampion = this.mlService.getChampionRlModel();
    if (rlChampion) {
      const rlPolicy = this.asRlPolicy(rlChampion);
      if (rlPolicy && (!this.rl || this.rl.id !== rlChampion.id)) {
        this.rl = {
          id: rlChampion.id,
          strategy: new RlPolicyStrategy(this.db, rlPolicy, this.logger),
        };
      }
    } else {
      this.rl = undefined;
    }

    if (champion && champion.kind !== 'rl_linear_q') {
      if (!this.supervised || this.supervised.id !== champion.id) {
        this.supervised = {
          id: champion.id,
          strategy: new SupervisedLinearStrategy(champion as TrainedModel),
        };
      }
    } else {
      this.supervised = undefined;
    }
  }

  private pickStrategy(): StrategyKind {
    const priorities: StrategyKind[] =
      this.config.rollout.mode === 'tiny_live'
        ? ['supervised', 'rl', 'momentum']
        : ['rl', 'supervised', 'momentum'];

    for (const kind of priorities) {
      if (kind === 'rl') {
        if (this.config.rl.enabled && this.rl) return 'rl';
        continue;
      }
      if (kind === 'supervised') {
        if (this.supervised) return 'supervised';
        continue;
      }
      return 'momentum';
    }
    return 'momentum';
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
      epsilon: 0,
    };
  }
}
