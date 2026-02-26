import type { Broker } from './broker.js';
import { randomUUID } from 'node:crypto';
import type { BrokerOrderRequest, BrokerOrderResult, Fill, OrderRecord, Position } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';

interface PaperBrokerOptions {
  feeBps: number;
  slippageBps: number;
}

export class PaperBroker implements Broker {
  private positions = new Map<string, Position>();
  private readonly logger: Logger;

  constructor(
    private readonly db: StateDb,
    logger: Logger,
    private readonly options: PaperBrokerOptions,
  ) {
    this.logger = logger.child('paper-broker');
  }

  async placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const existing = this.db.getOrderByClientId(request.clientOrderId);
    if (existing) {
      const fills = this.db.getFills(1_000).filter(item => item.orderId === existing.exchangeOrderId);
      return {
        orderId: existing.exchangeOrderId,
        status: existing.status,
        reason: existing.reason,
        fills,
        filledQuantity: existing.filledQuantity,
        avgFillPrice: existing.avgFillPrice,
        acceptedAt: existing.createdAt,
      };
    }

    const now = Date.now();
    const orderId = `paper-${request.clientOrderId}`;
    const slip = this.options.slippageBps / 10_000;
    const feeRate = this.options.feeBps / 10_000;
    const filledQuantity = request.quantity;
    const fillParts = Math.random() > 0.45 ? [filledQuantity] : [filledQuantity * 0.6, filledQuantity * 0.4];
    const fills: Fill[] = [];
    let sumPxQty = 0;
    let totalFees = 0;
    for (const part of fillParts) {
      const signedSlip = request.side === 'buy' ? 1 + slip : 1 - slip;
      const price = request.markPrice * signedSlip;
      const fee = price * part * feeRate;
      sumPxQty += price * part;
      totalFees += fee;
      fills.push({
        fillId: randomUUID(),
        orderId,
        symbol: request.symbol,
        side: request.side,
        price,
        quantity: part,
        fee,
        timestamp: now,
      });
    }
    const avgFillPrice = sumPxQty / filledQuantity;

    const { updated, realizedPnlUsd } = this.applyPositionUpdate(request.symbol, request.side, filledQuantity, avgFillPrice);
    updated.updatedAt = now;
    this.positions.set(updated.symbol, updated);

    const order: OrderRecord = {
      clientOrderId: request.clientOrderId,
      exchangeOrderId: orderId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      filledQuantity,
      avgFillPrice,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    };
    this.db.upsertOrder(order);
    for (const fill of fills) {
      this.db.insertFill(fill);
    }
    this.db.upsertPosition(updated);

    this.logger.info('paper order filled', {
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      avgFillPrice,
      realizedPnlUsd,
    });

    return {
      orderId,
      status: 'accepted',
      fills,
      filledQuantity,
      avgFillPrice,
      acceptedAt: now,
      realizedPnlUsd,
      feesUsd: totalFees,
    };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const existing = this.db.getOrderByClientId(clientOrderId);
    if (!existing || existing.status !== 'accepted') return;
    this.db.upsertOrder({
      ...existing,
      status: 'rejected',
      reason: 'cancelled',
      updatedAt: Date.now(),
    });
  }

  async getOpenPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }

  async reconcile(): Promise<void> {
    const fromDb = this.db.getPositions();
    this.positions.clear();
    for (const position of fromDb) {
      this.positions.set(position.symbol, position);
    }
  }

  private applyPositionUpdate(
    symbol: string,
    side: 'buy' | 'sell',
    qty: number,
    price: number,
  ): { updated: Position; realizedPnlUsd: number } {
    const current =
      this.positions.get(symbol) ??
      ({
        symbol,
        quantity: 0,
        avgPrice: 0,
        unrealizedPnl: 0,
        updatedAt: Date.now(),
      } satisfies Position);

    const signedQty = side === 'buy' ? qty : -qty;
    const existingQty = current.quantity;
    const nextQty = existingQty + signedQty;

    let realizedPnlUsd = 0;
    let avgPrice = current.avgPrice;

    if (existingQty === 0 || Math.sign(existingQty) === Math.sign(signedQty)) {
      const totalNotional = Math.abs(existingQty) * current.avgPrice + Math.abs(signedQty) * price;
      avgPrice = totalNotional / Math.max(1e-9, Math.abs(nextQty));
    } else {
      const closedQty = Math.min(Math.abs(existingQty), Math.abs(signedQty));
      const pnlPerUnit = existingQty > 0 ? price - current.avgPrice : current.avgPrice - price;
      realizedPnlUsd = closedQty * pnlPerUnit;
      if (nextQty === 0) {
        avgPrice = 0;
      } else if (Math.sign(nextQty) !== Math.sign(existingQty)) {
        avgPrice = price;
      }
    }

    const updated: Position = {
      symbol,
      quantity: nextQty,
      avgPrice,
      unrealizedPnl: 0,
      updatedAt: Date.now(),
    };
    return { updated, realizedPnlUsd };
  }
}
