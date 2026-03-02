export type TradingSymbol = 'BTCUSDT' | 'ETHUSDT' | (string & {});
export type Timeframe = '1m' | '5m' | '1h';
export type OrderSide = 'buy' | 'sell';
export type SignalAction = 'buy' | 'sell' | 'hold';
export type OrderStatus = 'pending' | 'partial' | 'filled' | 'canceled' | 'rejected';

export interface Candle {
  symbol: TradingSymbol;
  timeframe: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
  source: 'exchange' | 'mock' | 'gap_fill';
}

export interface TradeTick {
  symbol: TradingSymbol;
  timestamp: number;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
  tradeId?: string;
  source: 'exchange' | 'mock';
}

export interface Signal {
  symbol: TradingSymbol;
  timeframe: Timeframe;
  action: SignalAction;
  strength: number;
  reason: string;
  policy?: 'rl' | 'supervised' | 'momentum';
  qGap?: number;
  regime?: 'trend' | 'mean';
  gateTriggered?: boolean;
  timestamp: number;
}

export interface ShadowGateStatus {
  passed: boolean;
  reason: string;
  tier?: number;
  passedTier?: number;
  currentTier?: number;
  trades?: number;
  elapsedMs?: number;
  kpi?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  maxSizeUsd?: number;
}

export interface BrokerOrderRequest {
  symbol: TradingSymbol;
  side: OrderSide;
  quantity: number;
  clientOrderId: string;
  requestedAt: number;
  markPrice: number;
  intent: 'paper' | 'live';
}

export interface BrokerOrderResult {
  orderId: string;
  status: OrderStatus;
  reason?: string;
  fills?: Fill[];
  filledQuantity?: number;
  avgFillPrice?: number;
  acceptedAt?: number;
  realizedPnlUsd?: number;
  feesUsd?: number;
}

export interface Position {
  symbol: TradingSymbol;
  quantity: number;
  avgPrice: number;
  unrealizedPnl: number;
  updatedAt: number;
}

export interface Fill {
  fillId: string;
  orderId: string;
  symbol: TradingSymbol;
  side: OrderSide;
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}

export interface OrderRecord {
  clientOrderId: string;
  exchangeOrderId: string;
  symbol: TradingSymbol;
  side: OrderSide;
  quantity: number;
  filledQuantity: number;
  avgFillPrice: number;
  status: OrderStatus;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  updatedAt: number;
}

export interface EquityPoint {
  timestamp: number;
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  drawdownPct: number;
}

export interface AlertEvent {
  id: string;
  level: 'warning' | 'critical';
  type: 'risk_limit' | 'data_feed_down' | 'order_failure' | 'drawdown_breach' | 'kill_switch';
  message: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  type:
    | 'signal_generated'
    | 'risk_decision'
    | 'order_submitted'
    | 'order_result'
    | 'rl_execution_guard_blocked'
    | 'model_promotion'
    | 'rollout_stage_change'
    | 'alert';
  timestamp: number;
  payload: Record<string, unknown>;
}
