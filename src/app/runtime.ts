import { config } from '../core/config.js';
import { CandlesCache } from '../market/candles-cache.js';
import { MarketDataFeed } from '../market/market-feed.js';
import { ApiServer } from '../api/server.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { PaperBroker } from '../execution/paper-broker.js';
import { LiveBroker } from '../execution/live-broker.js';
import { OrderManager } from '../execution/order-manager.js';
import { TradingEngine } from './trading-engine.js';
import { BacktestService } from '../backtest/backtest-service.js';
import { MlService } from '../ml/ml-service.js';
import { RlShadowSimulator } from '../ml/rl-shadow-simulator.js';
import { StrategyRouter } from '../strategy/strategy-router.js';

export class AppRuntime {
  private readonly logger = new Logger('hydra');
  private readonly db = new StateDb(config.db.path);
  private readonly cache = new CandlesCache(config.market.cacheLimit);
  private readonly feed = new MarketDataFeed(this.db, this.cache, this.logger, {
    mode: config.market.mode,
    symbols: config.market.symbols,
    timeframes: config.market.timeframes,
  });
  private readonly paperBroker = new PaperBroker(this.db, this.logger, {
    feeBps: config.execution.feeBps,
    slippageBps: config.execution.slippageBps,
  });
  private readonly liveBroker = new LiveBroker(this.logger, {
    enabled: config.rollout.enableLiveOrders && !config.execution.paperOnly,
    tinyLiveMaxNotionalUsd: config.rollout.tinyLiveMaxNotionalUsd,
    mode: 'testnet',
  });
  private readonly orderManager = new OrderManager(
    { paper: this.paperBroker, live: this.liveBroker },
    this.db,
    this.logger,
  );
  private readonly mlService = new MlService(this.db, this.logger, config);
  private readonly strategyRouter = new StrategyRouter(this.db, this.mlService, this.logger, config);
  private readonly tradingEngine = new TradingEngine(
    this.db,
    this.feed,
    this.orderManager,
    this.strategyRouter,
    this.logger,
    config,
  );
  private readonly backtestService = new BacktestService(this.db, this.logger, config);
  private readonly rlShadow = new RlShadowSimulator(this.logger, config, () => this.mlService.getChampionRlModel());
  private readonly api = new ApiServer(this.db, this.cache, this.feed, {
      getTradingStatus: () => this.tradingEngine.getRuntimeStatus(),
      getBacktestStatus: () => ({
        ...this.backtestService.getGateStatus(),
        result: this.backtestService.getLastResult(),
      }),
      runBacktest: () => {
        const run = this.backtestService.runLatest();
        this.tradingEngine.setBacktestGate(run.passed, run.reason);
        return run;
      },
      getModelRegistry: () => this.mlService.getRegistrySnapshot(),
      getModelCheckpoints: (limit: number) => this.mlService.getCheckpointList(limit),
      retrainModel: async () => {
        const output = await this.mlService.retrain(this.tradingEngine.getPaperWindowMetrics());
        return output;
      },
      getRlStatus: () => this.rlShadow.getStatus(),
    },
    this.logger,
    {
      host: config.app.host,
      port: config.app.port,
      streamHistoryLimit: config.market.streamHistoryLimit,
    },
  );
  private started = false;
  private healthTimer?: NodeJS.Timeout;
  private shadowGuardTimer?: NodeJS.Timeout;
  private feedHeartbeatStale = false;

  async start(): Promise<void> {
    if (this.started) return;
    await this.feed.start();
    this.rlShadow.start();
    this.feed.on('candle', candle => this.rlShadow.onCandle(candle));
    const gate = this.backtestService.runLatest();
    this.tradingEngine.setBacktestGate(gate.passed, gate.reason);
    await this.tradingEngine.start();
    this.mlService.start(() => this.tradingEngine.getPaperWindowMetrics());
    await this.api.start();
    this.startFeedHealthMonitor();
    this.startShadowGuardMonitor();
    this.started = true;
    this.logger.info('runtime started', {
      mode: config.market.mode,
      symbols: config.market.symbols.join(','),
      port: config.app.port,
      rolloutMode: config.rollout.mode,
      backtestGate: gate,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.shadowGuardTimer) clearInterval(this.shadowGuardTimer);
    await this.api.stop();
    this.mlService.stop();
    this.rlShadow.stop();
    await this.tradingEngine.stop();
    await this.feed.stop();
    this.db.close();
    this.started = false;
    this.logger.info('runtime stopped');
  }

  private startFeedHealthMonitor(): void {
    this.healthTimer = setInterval(() => {
      const last = this.feed.getLastEventTimestamp();
      if (last === 0) return;
      const lagMs = Date.now() - last;
      const stale = lagMs > 45_000;
      if (stale && !this.feedHeartbeatStale) {
        this.tradingEngine.emitExternalAlert('critical', 'data_feed_down', 'market feed heartbeat stale', {
          lagMs,
        });
        this.feedHeartbeatStale = true;
        return;
      }
      if (!stale && this.feedHeartbeatStale) {
        this.feedHeartbeatStale = false;
        this.logger.info('market feed heartbeat restored', { lagMs });
      }
    }, 15_000);
  }

  private startShadowGuardMonitor(): void {
    this.shadowGuardTimer = setInterval(() => {
      const status = this.rlShadow.getStatus();
      const result = this.mlService.checkShadowGuard(status);
      if (result && (result as Record<string, unknown>).rolledBack) {
        this.logger.error('shadow guard triggered champion rollback', result);
      }
    }, 20_000);
  }
}
