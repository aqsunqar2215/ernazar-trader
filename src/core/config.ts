import 'dotenv/config';
import type { Timeframe, TradingSymbol } from './types.js';

type MarketMode = 'mock' | 'binance';

export interface AppConfig {
  env: string;
  app: {
    host: string;
    port: number;
  };
  db: {
    path: string;
  };
  market: {
    mode: MarketMode;
    symbols: TradingSymbol[];
    timeframes: Timeframe[];
    cacheLimit: number;
    streamHistoryLimit: number;
  };
  risk: {
    maxRiskPerTradePct: number;
    maxDailyLossUsd: number;
    maxDrawdownPct: number;
    maxOrdersPerMinute: number;
    maxTurnoverPerHour: number;
    cooldownLossStreak: number;
    cooldownLossMinutes: number;
  };
  execution: {
    feeBps: number;
    slippageBps: number;
    initialEquityUsd: number;
    paperOnly: boolean;
  };
  ml: {
    minWalkForwardSharpe: number;
    minWalkForwardProfitFactor: number;
    maxWalkForwardDrawdown: number;
    minPaperProfitFactor: number;
    minPaperSharpe: number;
    minPaperTrades: number;
    simplePromotionEnabled: boolean;
    simplePromotionAllowRl: boolean;
    simplePromotionMinWinRate: number;
    simplePromotionMinNetPnl: number;
    holdoutRatio: number;
    purgeBars: number;
    retrainCandlesLimit: number;
    retrainFillsLimit: number;
    supervisedWfFolds: number;
    rlWfFolds: number;
    pretrainMonths: number;
    pretrainMinCandles: number;
    pretrainWfFolds: number;
    unseenGateEnabled: boolean;
    unseenBars: number;
    unseenMinProfitFactor: number;
    unseenMinSharpe: number;
    unseenMinTrades: number;
    minRetrainIntervalMinutes: number;
    retrainIntervalHours: number;
    registryPath: string;
    oosMinCandlesPerSymbol: number;
  };
  rl: {
    enabled: boolean;
    episodes: number;
    learningRate: number;
    gamma: number;
    epsilonStart: number;
    epsilonEnd: number;
    latencyBars: number;
    turnoverPenaltyBps: number;
    drawdownPenaltyFactor: number;
    rewardCostWeight: number;
    rewardHoldPenalty: number;
    rewardActionBonus: number;
    confidenceGateEnabled: boolean;
    confidenceQGap: number;
    confidenceQGapAdaptiveEnabled: boolean;
    confidenceQGapAdaptiveQuantile: number;
    confidenceQGapAdaptiveScale: number;
    confidenceQGapMin: number;
    minSignalStrength: number;
    holdFlattenEnabled: boolean;
    minHoldBars: number;
    flipCooldownBars: number;
    maxPositionBars: number;
    regimeSplitEnabled: boolean;
    ensembleEnabled: boolean;
    ensembleSize: number;
    minEpisodes: number;
    earlyStopPatience: number;
    earlyStopMinDelta: number;
    minRetrainIntervalMinutes: number;
    maxConsecutiveNonPromoted: number;
    cooldownTradesAfterStop: number;
    disablePacing: boolean;
    shadowEnabled: boolean;
    regimeBalanced: boolean;
    regimeLookbackBars: number;
    regimeEpisodeBars: number;
    regimeStrideBars: number;
    pretrainEpisodes: number;
    pretrainMinEpisodes: number;
    hardNegativeReplayEnabled: boolean;
    hardNegativeReplayEpisodes: number;
    hardNegativeReplayMinEpisodes: number;
    hardNegativeReplayMaxWindows: number;
    hardNegativeReplayWindowBars: number;
    shadowGuardEnabled: boolean;
    shadowGuardGraceMinutes: number;
    shadowGuardMinTrades: number;
    shadowGuardMinProfitFactor: number;
    shadowGuardMaxDrawdownPct: number;
    shadowGuardMinNetPnlUsd: number;
    shadowGateEnabled: boolean;
    shadowGateTier1Trades: number;
    shadowGateTier2Trades: number;
    shadowGateTier3Trades: number;
    shadowGateTier1TimeoutHours: number;
    shadowGateTier2TimeoutHours: number;
    shadowGateTier3TimeoutHours: number;
    shadowGateMaxTradesPerMinute: number;
    shadowGateMinProfitFactor: number;
    shadowGateMinNetPnlUsd: number;
    shadowGateMaxDrawdownPct: number;
    shadowGateRequiredTier: number;
  };
  rollout: {
    mode: 'paper' | 'tiny_live';
    tinyLiveMaxNotionalUsd: number;
    enableLiveOrders: boolean;
    paperSanityMinNetPnlUsd: number;
    paperSanityMaxDrawdownPct: number;
  };
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = <T extends string>(value: string | undefined, fallback: T[]): T[] => {
  if (!value) return fallback;
  const parts = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts as T[];
};

const symbols = parseList<TradingSymbol>(process.env.SYMBOLS, ['BTCUSDT', 'ETHUSDT']);
const timeframes = parseList<Timeframe>(process.env.TIMEFRAMES, ['1m', '5m', '1h']);
const marketMode = (process.env.MARKET_MODE as MarketMode) || 'mock';
const rolloutMode = (process.env.ROLLOUT_MODE as 'paper' | 'tiny_live') || 'paper';
const paperOnly = (process.env.PAPER_ONLY || 'true').toLowerCase() !== 'false';
const isMockPaperMode = marketMode === 'mock' && rolloutMode === 'paper' && paperOnly;

const mockModeMlDefaults = {
  minWalkForwardSharpe: -27.5,
  minWalkForwardProfitFactor: 1.0,
  minPaperProfitFactor: 1.0,
  minPaperSharpe: 0.9,
  minPaperTrades: 8,
};

const standardMlDefaults = {
  minWalkForwardSharpe: -9.1,
  minWalkForwardProfitFactor: 1.03,
  minPaperProfitFactor: 1.02,
  minPaperSharpe: 4.5,
  minPaperTrades: 20,
};

const mlDefaults = isMockPaperMode ? mockModeMlDefaults : standardMlDefaults;

export const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  app: {
    host: process.env.HOST || '0.0.0.0',
    port: parseNumber(process.env.PORT, 8080),
  },
  db: {
    path: process.env.DB_PATH || './data/trader.db',
  },
  market: {
    mode: marketMode,
    symbols,
    timeframes,
    cacheLimit: parseNumber(process.env.CACHE_LIMIT, 2_000),
    streamHistoryLimit: parseNumber(process.env.STREAM_HISTORY_LIMIT, 400),
  },
  risk: {
    maxRiskPerTradePct: parseNumber(process.env.MAX_RISK_PER_TRADE_PCT, 1.0),
    maxDailyLossUsd: parseNumber(process.env.MAX_DAILY_LOSS_USD, 250),
    maxDrawdownPct: parseNumber(process.env.MAX_DRAWDOWN_PCT, 10),
    maxOrdersPerMinute: parseNumber(process.env.MAX_ORDERS_PER_MINUTE, 8),
    maxTurnoverPerHour: parseNumber(process.env.MAX_TURNOVER_PER_HOUR, 120),
    cooldownLossStreak: parseNumber(process.env.COOLDOWN_LOSS_STREAK, 3),
    cooldownLossMinutes: parseNumber(process.env.COOLDOWN_LOSS_MINUTES, 15),
  },
  execution: {
    feeBps: parseNumber(process.env.FEE_BPS, 10),
    slippageBps: parseNumber(process.env.SLIPPAGE_BPS, 2),
    initialEquityUsd: parseNumber(process.env.INITIAL_EQUITY_USD, 10_000),
    paperOnly,
  },
  ml: {
    minWalkForwardSharpe: parseNumber(process.env.MIN_WF_SHARPE, mlDefaults.minWalkForwardSharpe),
    minWalkForwardProfitFactor: parseNumber(process.env.MIN_WF_PROFIT_FACTOR, mlDefaults.minWalkForwardProfitFactor),
    maxWalkForwardDrawdown: parseNumber(process.env.MAX_WF_DRAWDOWN, 0.35),
    minPaperProfitFactor: parseNumber(process.env.MIN_PAPER_PROFIT_FACTOR, mlDefaults.minPaperProfitFactor),
    minPaperSharpe: parseNumber(process.env.MIN_PAPER_SHARPE, mlDefaults.minPaperSharpe),
    minPaperTrades: parseNumber(process.env.MIN_PAPER_TRADES, mlDefaults.minPaperTrades),
    simplePromotionEnabled: (process.env.ML_SIMPLE_PROMOTION_ENABLED || 'true').toLowerCase() !== 'false',
    simplePromotionAllowRl: (process.env.ML_SIMPLE_PROMOTION_ALLOW_RL || 'false').toLowerCase() === 'true',
    simplePromotionMinWinRate: parseNumber(process.env.ML_SIMPLE_PROMOTION_MIN_WIN_RATE, 0.5),
    simplePromotionMinNetPnl: parseNumber(process.env.ML_SIMPLE_PROMOTION_MIN_NET_PNL, 0),
    holdoutRatio: parseNumber(process.env.ML_HOLDOUT_RATIO, 0.25),
    purgeBars: parseNumber(process.env.ML_PURGE_BARS, 100),
    retrainCandlesLimit: parseNumber(process.env.ML_RETRAIN_CANDLES_LIMIT, 50_000),
    retrainFillsLimit: parseNumber(process.env.ML_RETRAIN_FILLS_LIMIT, 20_000),
    supervisedWfFolds: parseNumber(process.env.ML_SUPERVISED_WF_FOLDS, 4),
    rlWfFolds: parseNumber(process.env.ML_RL_WF_FOLDS, 2),
    pretrainMonths: parseNumber(process.env.ML_PRETRAIN_MONTHS, 6),
    pretrainMinCandles: parseNumber(process.env.ML_PRETRAIN_MIN_CANDLES, 20_000),
    pretrainWfFolds: parseNumber(process.env.ML_PRETRAIN_WF_FOLDS, 4),
    unseenGateEnabled: (process.env.ML_UNSEEN_GATE_ENABLED || 'true').toLowerCase() !== 'false',
    unseenBars: parseNumber(process.env.ML_UNSEEN_BARS, 43_200),
    unseenMinProfitFactor: parseNumber(process.env.ML_UNSEEN_MIN_PROFIT_FACTOR, 1.0),
    unseenMinSharpe: parseNumber(process.env.ML_UNSEEN_MIN_SHARPE, 0.9),
    unseenMinTrades: parseNumber(process.env.ML_UNSEEN_MIN_TRADES, 8),
    minRetrainIntervalMinutes: parseNumber(process.env.ML_MIN_RETRAIN_INTERVAL_MINUTES, 5),
    retrainIntervalHours: parseNumber(process.env.RETRAIN_INTERVAL_HOURS, 24),
    registryPath: process.env.MODEL_REGISTRY_PATH || './data/model-registry.json',
    oosMinCandlesPerSymbol: parseNumber(process.env.ML_OOS_MIN_CANDLES_PER_SYMBOL, 43_200),
  },
  rl: {
    enabled: (process.env.RL_ENABLED || 'true').toLowerCase() !== 'false',
    episodes: parseNumber(process.env.RL_EPISODES, 180),
    learningRate: parseNumber(process.env.RL_LEARNING_RATE, 0.02),
    gamma: parseNumber(process.env.RL_GAMMA, 0.97),
    epsilonStart: parseNumber(process.env.RL_EPSILON_START, 0.35),
    epsilonEnd: parseNumber(process.env.RL_EPSILON_END, 0.05),
    latencyBars: parseNumber(process.env.RL_LATENCY_BARS, 1),
    turnoverPenaltyBps: parseNumber(process.env.RL_TURNOVER_PENALTY_BPS, 0.5),
    drawdownPenaltyFactor: parseNumber(process.env.RL_DRAWDOWN_PENALTY, 0.05),
    rewardCostWeight: parseNumber(process.env.RL_REWARD_COST_WEIGHT, 0.8),
    rewardHoldPenalty: parseNumber(process.env.RL_REWARD_HOLD_PENALTY, 0.00012),
    rewardActionBonus: parseNumber(process.env.RL_REWARD_ACTION_BONUS, 0),
    confidenceGateEnabled: (process.env.RL_CONFIDENCE_GATE_ENABLED || 'true').toLowerCase() === 'true',
    confidenceQGap: parseNumber(process.env.RL_CONFIDENCE_Q_GAP, 0.02),
    confidenceQGapAdaptiveEnabled: (process.env.RL_CONFIDENCE_Q_GAP_ADAPTIVE_ENABLED || 'true').toLowerCase() !== 'false',
    confidenceQGapAdaptiveQuantile: parseNumber(process.env.RL_CONFIDENCE_Q_GAP_ADAPTIVE_QUANTILE, 0.6),
    confidenceQGapAdaptiveScale: parseNumber(process.env.RL_CONFIDENCE_Q_GAP_ADAPTIVE_SCALE, 0.8),
    confidenceQGapMin: parseNumber(process.env.RL_CONFIDENCE_Q_GAP_MIN, 0.001),
    minSignalStrength: parseNumber(process.env.RL_MIN_SIGNAL_STRENGTH, 0),
    holdFlattenEnabled: (process.env.RL_HOLD_FLATTEN_ENABLED || 'false').toLowerCase() === 'true',
    minHoldBars: parseNumber(process.env.RL_MIN_HOLD_BARS, 5),
    flipCooldownBars: parseNumber(process.env.RL_FLIP_COOLDOWN_BARS, 8),
    maxPositionBars: parseNumber(process.env.RL_MAX_POSITION_BARS, 0),
    regimeSplitEnabled: (process.env.RL_REGIME_SPLIT_ENABLED || 'false').toLowerCase() === 'true',
    ensembleEnabled: (process.env.RL_ENSEMBLE_ENABLED || 'false').toLowerCase() === 'true',
    ensembleSize: parseNumber(process.env.RL_ENSEMBLE_SIZE, 5),
    minEpisodes: parseNumber(process.env.RL_MIN_EPISODES, 80),
    earlyStopPatience: parseNumber(process.env.RL_EARLY_STOP_PATIENCE, 35),
    earlyStopMinDelta: parseNumber(process.env.RL_EARLY_STOP_MIN_DELTA, 0.0004),
    minRetrainIntervalMinutes: parseNumber(process.env.RL_MIN_RETRAIN_INTERVAL_MINUTES, 3),
    maxConsecutiveNonPromoted: parseNumber(process.env.RL_MAX_CONSECUTIVE_NON_PROMOTED, 12),
    cooldownTradesAfterStop: parseNumber(process.env.RL_COOLDOWN_TRADES_AFTER_STOP, 10),
    disablePacing: (process.env.RL_DISABLE_PACING || 'false').toLowerCase() === 'true',
    shadowEnabled: (process.env.RL_SHADOW_ENABLED || 'true').toLowerCase() !== 'false',
    regimeBalanced: (process.env.RL_REGIME_BALANCED || 'true').toLowerCase() !== 'false',
    regimeLookbackBars: parseNumber(process.env.RL_REGIME_LOOKBACK_BARS, 96),
    regimeEpisodeBars: parseNumber(process.env.RL_REGIME_EPISODE_BARS, 320),
    regimeStrideBars: parseNumber(process.env.RL_REGIME_STRIDE_BARS, 6),
    pretrainEpisodes: parseNumber(process.env.RL_PRETRAIN_EPISODES, 220),
    pretrainMinEpisodes: parseNumber(process.env.RL_PRETRAIN_MIN_EPISODES, 120),
    hardNegativeReplayEnabled: (process.env.RL_HARD_NEG_REPLAY_ENABLED || 'true').toLowerCase() !== 'false',
    hardNegativeReplayEpisodes: parseNumber(process.env.RL_HARD_NEG_REPLAY_EPISODES, 80),
    hardNegativeReplayMinEpisodes: parseNumber(process.env.RL_HARD_NEG_REPLAY_MIN_EPISODES, 30),
    hardNegativeReplayMaxWindows: parseNumber(process.env.RL_HARD_NEG_REPLAY_MAX_WINDOWS, 40),
    hardNegativeReplayWindowBars: parseNumber(process.env.RL_HARD_NEG_REPLAY_WINDOW_BARS, 360),
    shadowGuardEnabled: (process.env.RL_SHADOW_GUARD_ENABLED || 'true').toLowerCase() !== 'false',
    shadowGuardGraceMinutes: parseNumber(process.env.RL_SHADOW_GUARD_GRACE_MINUTES, 90),
    shadowGuardMinTrades: parseNumber(process.env.RL_SHADOW_GUARD_MIN_TRADES, 16),
    shadowGuardMinProfitFactor: parseNumber(process.env.RL_SHADOW_GUARD_MIN_PF, 0.95),
    shadowGuardMaxDrawdownPct: parseNumber(process.env.RL_SHADOW_GUARD_MAX_DD_PCT, 6),
    shadowGuardMinNetPnlUsd: parseNumber(process.env.RL_SHADOW_GUARD_MIN_NET_PNL_USD, -40),
    shadowGateEnabled: (process.env.RL_SHADOW_GATE_ENABLED || 'true').toLowerCase() !== 'false',
    shadowGateTier1Trades: parseNumber(process.env.RL_SHADOW_GATE_TIER1_TRADES, 100),
    shadowGateTier2Trades: parseNumber(process.env.RL_SHADOW_GATE_TIER2_TRADES, 500),
    shadowGateTier3Trades: parseNumber(process.env.RL_SHADOW_GATE_TIER3_TRADES, 1000),
    shadowGateTier1TimeoutHours: parseNumber(process.env.RL_SHADOW_GATE_TIER1_TIMEOUT_HOURS, 24),
    shadowGateTier2TimeoutHours: parseNumber(process.env.RL_SHADOW_GATE_TIER2_TIMEOUT_HOURS, 24),
    shadowGateTier3TimeoutHours: parseNumber(process.env.RL_SHADOW_GATE_TIER3_TIMEOUT_HOURS, 48),
    shadowGateMaxTradesPerMinute: parseNumber(process.env.RL_SHADOW_GATE_MAX_TPM, 4),
    shadowGateMinProfitFactor: parseNumber(process.env.RL_SHADOW_GATE_MIN_PF, 1.12),
    shadowGateMinNetPnlUsd: parseNumber(process.env.RL_SHADOW_GATE_MIN_NET_PNL_USD, 0),
    shadowGateMaxDrawdownPct: parseNumber(process.env.RL_SHADOW_GATE_MAX_DD_PCT, 0.01),
    shadowGateRequiredTier: parseNumber(process.env.RL_SHADOW_GATE_REQUIRED_TIER, 500),
  },
  rollout: {
    mode: rolloutMode,
    tinyLiveMaxNotionalUsd: parseNumber(process.env.TINY_LIVE_MAX_NOTIONAL_USD, 100),
    enableLiveOrders: (process.env.ENABLE_LIVE_ORDERS || 'false').toLowerCase() === 'true',
    paperSanityMinNetPnlUsd: parseNumber(process.env.ROLLOUT_PAPER_SANITY_MIN_NET_PNL_USD, 0),
    paperSanityMaxDrawdownPct: parseNumber(process.env.ROLLOUT_PAPER_SANITY_MAX_DD_PCT, 0.01),
  },
};
