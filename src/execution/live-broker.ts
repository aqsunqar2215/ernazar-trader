import type { Broker } from './broker.js';
import type { BrokerOrderRequest, BrokerOrderResult, Position } from '../core/types.js';
import { Logger } from '../state/logger.js';

export class LiveBroker implements Broker {
  constructor(
    private readonly logger: Logger,
    private readonly options: {
      enabled: boolean;
      tinyLiveMaxNotionalUsd: number;
      mode: 'testnet' | 'mainnet';
    },
  ) {}

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const notional = request.quantity * request.markPrice;
    if (!this.options.enabled) {
      return {
        orderId: `live-disabled-${request.clientOrderId}`,
        status: 'rejected',
        reason: 'live orders disabled',
      };
    }
    if (notional > this.options.tinyLiveMaxNotionalUsd) {
      return {
        orderId: `live-reject-${request.clientOrderId}`,
        status: 'rejected',
        reason: `notional ${notional.toFixed(2)} exceeds tiny-live cap ${this.options.tinyLiveMaxNotionalUsd}`,
      };
    }

    this.logger.warn('live broker placeholder rejected order (wire exchange adapter)', {
      mode: this.options.mode,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
    });
    return {
      orderId: `live-${request.clientOrderId}`,
      status: 'rejected',
      reason: 'live broker not wired to exchange adapter',
      acceptedAt: Date.now(),
    };
  }

  async cancelOrder(_clientOrderId: string): Promise<void> {}

  async getOpenPositions(): Promise<Position[]> {
    return [];
  }

  async reconcile(): Promise<void> {}
}
