import type { Candle, Signal } from '../core/types.js';

export interface Strategy {
  onCandle(candle: Candle): Signal;
}
