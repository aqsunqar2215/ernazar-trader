import assert from 'node:assert/strict';
import type { Candle, Signal } from '../src/core/types.js';
import type { Strategy } from '../src/strategy/strategy.js';
import { BacktestEngine } from '../src/backtest/engine.js';

class MultiSymbolTestStrategy implements Strategy {
  private readonly seen = new Map<string, number>();

  onCandle(candle: Candle): Signal {
    const count = (this.seen.get(candle.symbol) ?? 0) + 1;
    this.seen.set(candle.symbol, count);
    if (count === 1) {
      return {
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        action: candle.symbol === 'BTCUSDT' ? 'buy' : 'sell',
        strength: 1,
        reason: 'open test position',
        timestamp: candle.openTime,
      };
    }
    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      action: 'hold',
      strength: 0,
      reason: 'noop',
      timestamp: candle.openTime,
    };
  }
}

const makeCandle = (symbol: Candle['symbol'], openTime: number, price: number): Candle => ({
  symbol,
  timeframe: '1m',
  openTime,
  closeTime: openTime + 60_000,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: 1,
  trades: 1,
  source: 'mock',
});

const candles: Candle[] = [];
const start = Date.now();
for (let i = 0; i < 30; i += 1) {
  const btcPrice = 65_000 + i * 100;
  const ethPrice = 3_500 - i * 10;
  candles.push(makeCandle('BTCUSDT', start + i * 60_000, btcPrice));
  candles.push(makeCandle('ETHUSDT', start + i * 60_000 + 30_000, ethPrice));
}

const engine = new BacktestEngine(() => new MultiSymbolTestStrategy());
const result = engine.run(candles, {
  initialCapitalUsd: 10_000,
  feeBps: 0,
  slippageBps: 0,
  latencyBars: 1,
  riskPerTradePct: 10,
});

assert.equal(result.trades.length, 2, 'expected one trade per symbol');
for (const trade of result.trades) {
  if (trade.symbol === 'BTCUSDT') {
    assert.ok(trade.entryPrice > 10_000, 'BTC trade entry should be in BTC price range');
    assert.ok(trade.exitPrice > 10_000, 'BTC trade exit should be in BTC price range');
  } else if (trade.symbol === 'ETHUSDT') {
    assert.ok(trade.entryPrice < 10_000, 'ETH trade entry should be in ETH price range');
    assert.ok(trade.exitPrice < 10_000, 'ETH trade exit should be in ETH price range');
  } else {
    assert.fail(`unexpected symbol in trade: ${trade.symbol}`);
  }
}

const maxEquity = Math.max(...result.equityCurve);
assert.ok(maxEquity < 20_000, 'equity curve should not spike >2x on multi-symbol test');
assert.ok(result.netPnl > 0, 'net pnl should be positive for the constructed scenario');

console.log('multi-symbol backtest test passed');
