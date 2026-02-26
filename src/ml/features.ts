import type { Candle, Fill } from '../core/types.js';

export const FEATURE_NAMES = [
  'returns',
  'volatility',
  'atr_norm',
  'rsi_norm',
  'ema_spread',
  'macd_hist_norm',
  'bb_pos',
  'adx_norm',
  'mom_3',
  'mom_12',
  'volume_z',
  'flow_imbalance',
  // Regime-detection features: directly capture trend vs mean-reversion dynamics
  'returns_autocorr',   // positive = trending, negative = mean-reverting
  'ema34_dist',         // price vs 34-bar EMA: trend direction strength
  'hurst_proxy',        // range-based Hurst-like indicator
  'bb_squeeze',         // low = bandwidth constricted (pre-breakout)

  // Non-linear interaction features (CRITICAL for linear models to learn regime-dependent behavior)
  'cross_trend_mom3',   // retAutocorr * mom_3: positive when trending, negative when mean-reverting
  'cross_trend_rsi',    // retAutocorr * (rsi - 0.5): scales RSI signal conditionally
  'cross_vol_bbpos',    // realizedVol * bb_pos: scales breakout signal by volatility
  // Position context (MDP observability)
  'pos',
  'pos_age',
  'last_turnover_age',
] as const;

// Increased from 36 → 40 to support 34-bar EMA and autocorrelation lag window
export const featureLookback = 40;

interface PositionFeatureState {
  position: number;
  positionAge: number;
  lastTurnoverAge: number;
}

const POSITION_AGE_NORMALIZER = 100;

export const extractFeatures = (
  window: Candle[],
  fills: Fill[] = [],
  positionState: PositionFeatureState = { position: 0, positionAge: 0, lastTurnoverAge: 0 },
): number[] => {
  const closes = window.map(candle => candle.close);
  const returns = closes.slice(1).map((value, index) => (value - closes[index]) / closes[index]);
  const volume = window.map(candle => candle.volume);
  const highs = window.map(candle => candle.high);
  const lows = window.map(candle => candle.low);
  const latest = window[window.length - 1];
  const emaFast = ema(closes, 8);
  const emaSlow = ema(closes, 21);
  const ema34 = ema(closes, 34);
  const macdHist = macdHistogram(closes, 12, 26, 9);
  const bbPos = bollingerPosition(closes, 20, 2);
  const bbWidth = bollingerWidth(closes, 20, 2);
  const adx14 = adx(highs, lows, closes, 14);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const mom3 = momentum(closes, 3);
  const mom12 = momentum(closes, 12);
  const realizedVol = stdDev(returns) * Math.sqrt(Math.max(1, returns.length));
  const meanReturn = avg(returns);
  const volZScore = zScore(volume);
  const recentFillImbalance = fillImbalance(fills, latest.closeTime, 60 * 60 * 1_000);
  // New regime-detection features
  const retAutocorr = autocorrelation(returns, 4);
  const ema34Dist = (latest.close - ema34) / Math.max(1e-9, ema34);
  const hurstP = hurstProxy(closes, 16);
  const bbSqueeze = Math.max(0, Math.min(1, 1 - bbWidth / Math.max(1e-9, realizedVol * 4)));

  const pos = Math.max(-1, Math.min(1, positionState.position));
  const posAge = Math.min(1, Math.max(0, positionState.positionAge) / POSITION_AGE_NORMALIZER);
  const turnoverAge = Math.min(1, Math.max(0, positionState.lastTurnoverAge) / POSITION_AGE_NORMALIZER);

  return [
    meanReturn,
    realizedVol,
    atr14 / Math.max(1e-9, latest.close),
    rsi14 / 100,
    (emaFast - emaSlow) / Math.max(1e-9, emaSlow),
    macdHist / Math.max(1e-9, latest.close),
    bbPos,
    adx14 / 100,
    mom3,
    mom12,
    volZScore,
    recentFillImbalance,
    // Regime features
    retAutocorr,
    ema34Dist,
    hurstP,
    bbSqueeze,

    // Cross features
    retAutocorr * mom3,
    retAutocorr * ((rsi14 / 100) - 0.5),
    realizedVol * bbPos,

    pos,
    posAge,
    turnoverAge,
  ];
};

const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

const stdDev = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = avg(values);
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
};

const ema = (values: number[], period: number): number => {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let current = values[0];
  for (let i = 1; i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
};

const rsi = (values: number[], period: number): number => {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
};

const atr = (high: number[], low: number[], close: number[], period: number): number => {
  if (close.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < close.length; i += 1) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
    trs.push(tr);
  }
  return avg(trs.slice(-period));
};

const momentum = (values: number[], bars: number): number => {
  if (values.length <= bars) return 0;
  const prev = values[values.length - 1 - bars];
  if (!Number.isFinite(prev) || prev === 0) return 0;
  return (values[values.length - 1] - prev) / prev;
};

const macdHistogram = (values: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): number => {
  if (values.length < slowPeriod + signalPeriod) return 0;
  const macdSeries: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const slice = values.slice(0, i + 1);
    macdSeries.push(ema(slice, fastPeriod) - ema(slice, slowPeriod));
  }
  const macdLine = macdSeries[macdSeries.length - 1];
  const signal = ema(macdSeries, signalPeriod);
  return macdLine - signal;
};

const bollingerPosition = (values: number[], period: number, stdMultiplier: number): number => {
  if (values.length < period) return 0.5;
  const window = values.slice(-period);
  const mean = avg(window);
  const bandStd = stdDev(window);
  const upper = mean + stdMultiplier * bandStd;
  const lower = mean - stdMultiplier * bandStd;
  const width = upper - lower;
  if (!Number.isFinite(width) || Math.abs(width) < 1e-9) return 0.5;
  const raw = (values[values.length - 1] - lower) / width;
  return Math.max(0, Math.min(1, raw));
};

const adx = (high: number[], low: number[], close: number[], period: number): number => {
  if (close.length < period + 2) return 0;
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];

  for (let i = 1; i < close.length; i += 1) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
    trs.push(tr);
  }

  if (trs.length < period) return 0;
  const dxValues: number[] = [];
  for (let i = period - 1; i < trs.length; i += 1) {
    const trSum = sum(trs.slice(i - period + 1, i + 1));
    if (trSum <= 1e-9) {
      dxValues.push(0);
      continue;
    }
    const plus = sum(plusDm.slice(i - period + 1, i + 1));
    const minus = sum(minusDm.slice(i - period + 1, i + 1));
    const plusDi = (plus / trSum) * 100;
    const minusDi = (minus / trSum) * 100;
    const den = plusDi + minusDi;
    dxValues.push(den <= 1e-9 ? 0 : (Math.abs(plusDi - minusDi) / den) * 100);
  }

  return avg(dxValues.slice(-period));
};

const zScore = (values: number[]): number => {
  if (values.length < 2) return 0;
  const m = avg(values);
  const sd = stdDev(values);
  if (sd === 0) return 0;
  return (values[values.length - 1] - m) / sd;
};

const fillImbalance = (fills: Fill[], maxTimeMs: number, lookbackMs: number): number => {
  const cutoff = maxTimeMs - lookbackMs;
  const recent = fills.filter(f => f.timestamp >= cutoff);
  if (recent.length === 0) return 0;
  let buyVol = 0;
  let sellVol = 0;
  for (const f of recent) {
    if (f.side === 'buy') buyVol += f.quantity;
    else sellVol += f.quantity;
  }
  const total = buyVol + sellVol;
  if (total === 0) return 0;
  return (buyVol - sellVol) / total;
};

const bollingerWidth = (values: number[], period: number, stdDevMult: number): number => {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const m = avg(slice);
  const sd = stdDev(slice);
  const upper = m + sd * stdDevMult;
  const lower = m - sd * stdDevMult;
  return (upper - lower) / Math.max(1e-9, m);
};

const autocorrelation = (values: number[], lag: number): number => {
  if (values.length <= lag) return 0;
  const m = avg(values);
  let variance = 0;
  let autocovariance = 0;
  for (let i = 0; i < values.length; i++) {
    variance += (values[i] - m) ** 2;
    if (i >= lag) {
      autocovariance += (values[i] - m) * (values[i - lag] - m);
    }
  }
  return variance === 0 ? 0 : autocovariance / variance;
};

const hurstProxy = (values: number[], period: number): number => {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const m = avg(slice);
  let maxDev = 0;
  let currentDev = 0;
  const devSeries = [];
  for (let i = 0; i < slice.length; i++) {
    currentDev += slice[i] - m;
    devSeries.push(currentDev);
  }
  const range = Math.max(...devSeries) - Math.min(...devSeries);
  const sd = stdDev(slice);
  if (sd === 0 || range === 0) return 0.5;
  // Approximation of Hurst exponent using R/S
  return Math.log(range / sd) / Math.log(period);
};

const sum = (values: number[]): number => values.reduce((acc, value) => acc + value, 0);
