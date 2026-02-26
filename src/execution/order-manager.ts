import type { Broker } from './broker.js';
import type { BrokerOrderRequest, BrokerOrderResult } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';

export class OrderManager {
  private readonly logger: Logger;

  constructor(
    private readonly brokers: { paper: Broker; live: Broker },
    private readonly db: StateDb,
    logger: Logger,
    private readonly maxRetries: number = 2,
  ) {
    this.logger = logger.child('order-manager');
  }

  async submit(request: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const existing = this.db.getOrderByClientId(request.clientOrderId);
    if (existing) {
      return {
        orderId: existing.exchangeOrderId,
        status: existing.status,
        reason: existing.reason,
        filledQuantity: existing.filledQuantity,
        avgFillPrice: existing.avgFillPrice,
        acceptedAt: existing.createdAt,
      };
    }

    let attempt = 0;
    const broker = request.intent === 'live' ? this.brokers.live : this.brokers.paper;
    while (attempt <= this.maxRetries) {
      try {
        return await broker.placeOrder(request);
      } catch (error) {
        attempt += 1;
        this.logger.warn('order submit retry', {
          clientOrderId: request.clientOrderId,
          attempt,
          error: String(error),
        });
        if (attempt > this.maxRetries) throw error;
      }
    }

    return {
      orderId: `failed-${request.clientOrderId}`,
      status: 'rejected',
      reason: 'retry exhausted',
    };
  }

  async reconcile(): Promise<void> {
    await this.brokers.paper.reconcile();
    await this.brokers.live.reconcile();
  }
}
