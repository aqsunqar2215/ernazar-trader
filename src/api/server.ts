import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type WebSocket from 'ws';
import { CandlesCache } from '../market/candles-cache.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';
import { fillGaps } from '../market/data-quality.js';
import type { Candle, Timeframe, TradeTick } from '../core/types.js';
import { MarketDataFeed } from '../market/market-feed.js';

interface ApiServerOptions {
  host: string;
  port: number;
  streamHistoryLimit: number;
}

interface ApiHandlers {
  getTradingStatus: () => Record<string, unknown>;
  getBacktestStatus: () => { passed: boolean; reason: string; result: Record<string, unknown> | null };
  runBacktest: () => { passed: boolean; reason: string; result: Record<string, unknown> };
  getModelRegistry: () => Record<string, unknown>;
  getModelCheckpoints: (limit: number) => Record<string, unknown>;
  retrainModel: () => Promise<Record<string, unknown>>;
  getRlStatus: () => Record<string, unknown>;
}

export class ApiServer {
  private readonly app: FastifyInstance;
  private readonly logger: Logger;
  private readonly wsClients = new Set<WebSocket>();
  private readonly streamHistory: Array<Candle | TradeTick> = [];
  private startedAt: number = Date.now();

  constructor(
    private readonly db: StateDb,
    private readonly cache: CandlesCache,
    private readonly feed: MarketDataFeed,
    private readonly handlers: ApiHandlers,
    logger: Logger,
    private readonly options: ApiServerOptions,
  ) {
    this.logger = logger.child('api');
    this.app = Fastify({ logger: false });
    this.wireMarketEvents();
  }

  private wireMarketEvents(): void {
    this.feed.on('candle', (event: Candle) => {
      this.pushHistory(event);
      this.broadcast({ type: 'candle', payload: event });
    });

    this.feed.on('trade', (event: TradeTick) => {
      this.pushHistory(event);
      this.broadcast({ type: 'trade', payload: event });
    });
  }

  private pushHistory(event: Candle | TradeTick): void {
    this.streamHistory.push(event);
    if (this.streamHistory.length > this.options.streamHistoryLimit) {
      this.streamHistory.splice(0, this.streamHistory.length - this.options.streamHistoryLimit);
    }
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await this.app.register(fastifyWebsocket);

    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    const uiRoot = resolve(currentDir, '../../ui');

    await this.app.register(fastifyStatic, {
      root: uiRoot,
      prefix: '/ui/',
      wildcard: false,
    });

    this.app.get('/health', async () => {
      return {
        status: 'ok',
        service: 'hydra-trader',
        uptimeMs: Date.now() - this.startedAt,
        wsClients: this.wsClients.size,
        trading: this.handlers.getTradingStatus(),
        backtestGate: this.handlers.getBacktestStatus().passed,
      };
    });

    this.app.get('/candles', async request => {
      const query = request.query as {
        symbol?: string;
        tf?: Timeframe;
        limit?: string;
      };

      const symbol = query.symbol || 'BTCUSDT';
      const timeframe = query.tf || '1m';
      const rawLimit = Number(query.limit || '500');
      const limit = Number.isFinite(rawLimit) ? Math.min(2_000, Math.max(1, rawLimit)) : 500;

      const cacheRows = this.cache.get(symbol, timeframe, limit);
      const dbRows = this.db.getCandles(symbol, timeframe, limit);
      const merged = [...dbRows, ...cacheRows];
      const dedupMap = new Map<number, Candle>();
      for (const item of merged) {
        dedupMap.set(item.openTime, item);
      }

      const rows = Array.from(dedupMap.values()).sort((a, b) => a.openTime - b.openTime);
      const normalized = fillGaps(rows, timeframe);
      const sliced = normalized.length <= limit ? normalized : normalized.slice(normalized.length - limit);

      return {
        symbol,
        timeframe,
        count: sliced.length,
        candles: sliced,
      };
    });

    this.app.get('/stream', { websocket: true }, connection => {
      const socket = connection;
      this.wsClients.add(socket);
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          payload: this.streamHistory,
        }),
      );

      socket.on('close', () => {
        this.wsClients.delete(socket);
      });
    });

    this.app.get('/runtime/status', async () => this.handlers.getTradingStatus());

    this.app.get('/runtime/orders', async request => {
      const query = request.query as { limit?: string };
      const limit = Math.min(1_000, Math.max(1, Number(query.limit || '200')));
      return { orders: this.db.getOrders(limit) };
    });

    this.app.get('/runtime/fills', async request => {
      const query = request.query as { limit?: string };
      const limit = Math.min(2_000, Math.max(1, Number(query.limit || '500')));
      return { fills: this.db.getFills(limit) };
    });

    this.app.get('/runtime/positions', async () => {
      return { positions: this.db.getPositions() };
    });

    this.app.get('/runtime/equity', async request => {
      const query = request.query as { limit?: string };
      const limit = Math.min(5_000, Math.max(1, Number(query.limit || '1000')));
      return { equity: this.db.getLatestEquity(limit) };
    });

    this.app.get('/runtime/alerts', async request => {
      const query = request.query as { limit?: string };
      const limit = Math.min(2_000, Math.max(1, Number(query.limit || '500')));
      return { alerts: this.db.getAlerts(limit) };
    });

    this.app.get('/runtime/audit', async request => {
      const query = request.query as { limit?: string };
      const limit = Math.min(5_000, Math.max(1, Number(query.limit || '1000')));
      return { events: this.db.getAuditEvents(limit) };
    });

    this.app.get('/backtest/status', async () => {
      return this.handlers.getBacktestStatus();
    });

    this.app.post('/backtest/run', async () => {
      return this.handlers.runBacktest();
    });

    this.app.get('/ml/registry', async () => {
      return this.handlers.getModelRegistry();
    });

    this.app.get('/ml/checkpoints', async request => {
      const query = request.query as { limit?: string };
      const rawLimit = Number(query.limit || '100');
      const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;
      return this.handlers.getModelCheckpoints(limit);
    });

    this.app.post('/ml/retrain', async () => {
      return this.handlers.retrainModel();
    });

    this.app.get('/rl/status', async () => {
      return this.handlers.getRlStatus();
    });

    await this.app.listen({ host: this.options.host, port: this.options.port });
    this.logger.info('api server started', { host: this.options.host, port: this.options.port });
  }

  async stop(): Promise<void> {
    for (const client of this.wsClients) {
      client.close();
    }
    this.wsClients.clear();
    await this.app.close();
  }

  private broadcast(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }
}
