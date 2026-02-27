import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  AlertEvent,
  AuditEvent,
  Balance,
  Candle,
  EquityPoint,
  Fill,
  OrderRecord,
  Position,
  TradeTick,
} from '../core/types.js';

interface CandleRow {
  symbol: string;
  timeframe: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
  source: string;
}

interface PositionRow {
  symbol: string;
  quantity: number;
  avg_price: number;
  unrealized_pnl: number;
  updated_at: number;
}

interface OrderRow {
  client_order_id: string;
  exchange_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  filled_quantity: number;
  avg_fill_price: number;
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

interface FillRow {
  fill_id: string;
  order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  fill_price: number;
  fill_qty: number;
  fee: number;
  ts: number;
}

interface EquityRow {
  ts: number;
  equity_usd: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  drawdown_pct: number;
}

interface AlertRow {
  id: string;
  level: 'warning' | 'critical';
  type: AlertEvent['type'];
  message: string;
  ts: number;
  meta: string | null;
}

interface AuditRow {
  id: string;
  type: AuditEvent['type'];
  ts: number;
  payload: string;
}

export class StateDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        open_time INTEGER NOT NULL,
        close_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        trades INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (symbol, timeframe, open_time)
      );

      CREATE TABLE IF NOT EXISTS market_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        side TEXT NOT NULL,
        trade_id TEXT,
        source TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_order_id TEXT NOT NULL UNIQUE,
        exchange_order_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        filled_quantity REAL NOT NULL DEFAULT 0,
        avg_fill_price REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fill_id TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        fill_price REAL NOT NULL,
        fill_qty REAL NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        symbol TEXT PRIMARY KEY,
        quantity REAL NOT NULL,
        avg_price REAL NOT NULL,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balances (
        asset TEXT PRIMARY KEY,
        free REAL NOT NULL,
        locked REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS equity_curve (
        ts INTEGER PRIMARY KEY,
        equity_usd REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL,
        unrealized_pnl_usd REAL NOT NULL,
        drawdown_pct REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        ts INTEGER NOT NULL,
        meta TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);

    this.ensureColumn('orders', 'filled_quantity', 'REAL NOT NULL DEFAULT 0');
    this.ensureColumn('orders', 'avg_fill_price', 'REAL NOT NULL DEFAULT 0');
    this.ensureColumn('orders', 'reason', 'TEXT');

    this.ensureColumn('fills', 'fill_id', 'TEXT');
    this.ensureColumn('fills', 'symbol', 'TEXT');
    this.ensureColumn('fills', 'side', 'TEXT');
    this.ensureColumn('fills', 'fee', 'REAL NOT NULL DEFAULT 0');
    this.ensureColumn('fills', 'ts', 'INTEGER NOT NULL DEFAULT 0');

    this.ensureColumn('positions', 'unrealized_pnl', 'REAL NOT NULL DEFAULT 0');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const stmt = this.db.prepare(`PRAGMA table_info(${table})`);
    const rows = stmt.all() as Array<{ name: string }>;
    const exists = rows.some(row => row.name === column);
    if (exists) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  upsertCandle(candle: Candle): void {
    const stmt = this.db.prepare(`
      INSERT INTO candles (
        symbol, timeframe, open_time, close_time, open, high, low, close, volume, trades, source
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
        close_time = excluded.close_time,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        trades = excluded.trades,
        source = excluded.source
    `);

    stmt.run(
      candle.symbol,
      candle.timeframe,
      candle.openTime,
      candle.closeTime,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      candle.trades,
      candle.source,
    );
  }

  insertTrade(trade: TradeTick): void {
    const stmt = this.db.prepare(`
      INSERT INTO market_trades (
        symbol, ts, price, quantity, side, trade_id, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      trade.symbol,
      trade.timestamp,
      trade.price,
      trade.quantity,
      trade.side,
      trade.tradeId ?? null,
      trade.source,
    );
  }

  upsertOrder(order: OrderRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO orders (
        client_order_id, exchange_order_id, symbol, side, quantity, filled_quantity, avg_fill_price, status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET
        exchange_order_id = excluded.exchange_order_id,
        filled_quantity = excluded.filled_quantity,
        avg_fill_price = excluded.avg_fill_price,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      order.clientOrderId,
      order.exchangeOrderId,
      order.symbol,
      order.side,
      order.quantity,
      order.filledQuantity,
      order.avgFillPrice,
      order.status,
      order.reason ?? null,
      order.createdAt,
      order.updatedAt,
    );
  }

  insertFill(fill: Fill): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO fills (
        fill_id, order_id, symbol, side, fill_price, fill_qty, fee, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(fill.fillId, fill.orderId, fill.symbol, fill.side, fill.price, fill.quantity, fill.fee, fill.timestamp);
  }

  upsertPosition(position: Position): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        symbol, quantity, avg_price, unrealized_pnl, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        quantity = excluded.quantity,
        avg_price = excluded.avg_price,
        unrealized_pnl = excluded.unrealized_pnl,
        updated_at = excluded.updated_at
    `);
    stmt.run(position.symbol, position.quantity, position.avgPrice, position.unrealizedPnl, position.updatedAt);
  }

  upsertBalance(balance: Balance): void {
    const stmt = this.db.prepare(`
      INSERT INTO balances (asset, free, locked, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(asset) DO UPDATE SET
        free = excluded.free,
        locked = excluded.locked,
        updated_at = excluded.updated_at
    `);
    stmt.run(balance.asset, balance.free, balance.locked, balance.updatedAt);
  }

  insertEquityPoint(point: EquityPoint): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO equity_curve (
        ts, equity_usd, realized_pnl_usd, unrealized_pnl_usd, drawdown_pct
      ) VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(point.timestamp, point.equityUsd, point.realizedPnlUsd, point.unrealizedPnlUsd, point.drawdownPct);
  }

  insertAlert(alert: AlertEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO alerts (id, level, type, message, ts, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(alert.id, alert.level, alert.type, alert.message, alert.timestamp, alert.meta ? JSON.stringify(alert.meta) : null);
  }

  insertAudit(event: AuditEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO audit_events (id, type, ts, payload)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(event.id, event.type, event.timestamp, JSON.stringify(event.payload));
  }

  getCandles(symbol: string, timeframe: string, limit: number): Candle[] {
    const stmt = this.db.prepare(`
      SELECT symbol, timeframe, open_time, close_time, open, high, low, close, volume, trades, source
      FROM candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY open_time DESC
      LIMIT ?
    `);

    const rows = stmt.all(symbol, timeframe, limit) as unknown as CandleRow[];
    rows.reverse();

    return rows.map(row => ({
      symbol: row.symbol,
      timeframe: row.timeframe as Candle['timeframe'],
      openTime: row.open_time,
      closeTime: row.close_time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      trades: row.trades,
      source: row.source as Candle['source'],
    }));
  }

  getRecentCandles(limit: number = 20_000): Candle[] {
    const stmt = this.db.prepare(`
      SELECT symbol, timeframe, open_time, close_time, open, high, low, close, volume, trades, source
      FROM candles
      ORDER BY open_time DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as CandleRow[];
    rows.reverse();
    return rows.map(row => ({
      symbol: row.symbol,
      timeframe: row.timeframe as Candle['timeframe'],
      openTime: row.open_time,
      closeTime: row.close_time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      trades: row.trades,
      source: row.source as Candle['source'],
    }));
  }

  getOrders(limit: number = 200): OrderRecord[] {
    const stmt = this.db.prepare(`
      SELECT client_order_id, exchange_order_id, symbol, side, quantity, filled_quantity, avg_fill_price, status, reason, created_at, updated_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as OrderRow[];
    return rows.map(row => ({
      clientOrderId: row.client_order_id,
      exchangeOrderId: row.exchange_order_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      filledQuantity: row.filled_quantity,
      avgFillPrice: row.avg_fill_price,
      status: normalizeOrderStatus(row.status),
      reason: row.reason ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getOrderByClientId(clientOrderId: string): OrderRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT client_order_id, exchange_order_id, symbol, side, quantity, filled_quantity, avg_fill_price, status, reason, created_at, updated_at
      FROM orders
      WHERE client_order_id = ?
      LIMIT 1
    `);
    const row = stmt.get(clientOrderId) as unknown as OrderRow | undefined;
    if (!row) return undefined;
    return {
      clientOrderId: row.client_order_id,
      exchangeOrderId: row.exchange_order_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      filledQuantity: row.filled_quantity,
      avgFillPrice: row.avg_fill_price,
      status: normalizeOrderStatus(row.status),
      reason: row.reason ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getFills(limit: number = 300): Fill[] {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(fill_id, CAST(id AS TEXT)) AS fill_id,
        CAST(order_id AS TEXT) AS order_id,
        COALESCE(symbol, 'BTCUSDT') AS symbol,
        COALESCE(side, 'buy') AS side,
        fill_price,
        fill_qty,
        COALESCE(fee, 0) AS fee,
        ts
      FROM fills
      ORDER BY ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as FillRow[];
    return rows.map(row => ({
      fillId: row.fill_id,
      orderId: row.order_id,
      symbol: row.symbol,
      side: row.side,
      price: row.fill_price,
      quantity: row.fill_qty,
      fee: row.fee,
      timestamp: row.ts,
    }));
  }

  getPositions(): Position[] {
    const stmt = this.db.prepare(`
      SELECT symbol, quantity, avg_price, unrealized_pnl, updated_at
      FROM positions
      ORDER BY symbol ASC
    `);
    const rows = stmt.all() as unknown as PositionRow[];
    return rows.map(row => ({
      symbol: row.symbol,
      quantity: row.quantity,
      avgPrice: row.avg_price,
      unrealizedPnl: row.unrealized_pnl,
      updatedAt: row.updated_at,
    }));
  }

  getLatestEquity(limit: number = 500): EquityPoint[] {
    const stmt = this.db.prepare(`
      SELECT ts, equity_usd, realized_pnl_usd, unrealized_pnl_usd, drawdown_pct
      FROM equity_curve
      ORDER BY ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as EquityRow[];
    rows.reverse();
    return rows.map(row => ({
      timestamp: row.ts,
      equityUsd: row.equity_usd,
      realizedPnlUsd: row.realized_pnl_usd,
      unrealizedPnlUsd: row.unrealized_pnl_usd,
      drawdownPct: row.drawdown_pct,
    }));
  }

  getAlerts(limit: number = 300): AlertEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, level, type, message, ts, meta
      FROM alerts
      ORDER BY ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as AlertRow[];
    return rows.map(row => ({
      id: row.id,
      level: row.level,
      type: row.type,
      message: row.message,
      timestamp: row.ts,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
    }));
  }

  getAuditEvents(limit: number = 800): AuditEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, type, ts, payload
      FROM audit_events
      ORDER BY ts DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as unknown as AuditRow[];
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      timestamp: row.ts,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  close(): void {
    this.db.close();
  }
}

const normalizeOrderStatus = (status: string): OrderRecord['status'] => {
  switch (status) {
    case 'filled':
    case 'partial':
    case 'pending':
    case 'canceled':
    case 'rejected':
      return status;
    case 'accepted':
      return 'filled';
    case 'cancelled':
      return 'canceled';
    default:
      return 'rejected';
  }
};
