import type { Broker } from './broker.js';
import { randomUUID } from 'node:crypto';
import type { BrokerOrderRequest, BrokerOrderResult, Fill, OrderRecord, Position } from '../core/types.js';
import { StateDb } from '../state/db.js';
import { Logger } from '../state/logger.js';

interface PaperBrokerOptions {
  feeBps: number;
  slippageBps: number;
  rejectRate?: number;
  partialFillRate?: number;
  minFillRatio?: number;
  maxFillRatio?: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
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
    const latencyMs = randomBetween(
      this.options.minLatencyMs ?? 120,
      this.options.maxLatencyMs ?? 950,
    );
    if (latencyMs > 0) {
      await sleep(latencyMs);
    }
    const executedAt = Date.now();
    const rejectRate = clampRate(this.options.rejectRate ?? 0.04);
    if (Math.random() < rejectRate) {
      const orderId = `paper-${request.clientOrderId}`;
      const order: OrderRecord = {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: orderId,
        symbol: request.symbol,
        side: request.side,
        quantity: request.quantity,
        filledQuantity: 0,
        avgFillPrice: 0,
        status: 'rejected',
        reason: 'simulated rejection',
        createdAt: now,
        updatedAt: executedAt,
      };
      this.db.upsertOrder(order);
      return {
        orderId,
        status: 'rejected',
        reason: order.reason,
        acceptedAt: executedAt,
      };
    }

    const orderId = `paper-${request.clientOrderId}`;
    const slip = this.options.slippageBps / 10_000;
    const feeRate = this.options.feeBps / 10_000;
    const partialFillRate = clampRate(this.options.partialFillRate ?? 0.25);
    const minFillRatio = clampRatio(this.options.minFillRatio ?? 0.45);
    const maxFillRatio = clampRatio(this.options.maxFillRatio ?? 0.9);
    const fillRatio = Math.random() < partialFillRate
      ? randomBetween(minFillRatio, Math.max(minFillRatio, maxFillRatio))
      : 1;
    const filledQuantity = Math.max(0, request.quantity * fillRatio);
    const status = filledQuantity >= request.quantity * 0.999 ? 'filled' : 'partial';
    const fillParts = splitFillParts(filledQuantity);
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
        timestamp: executedAt,
      });
    }
    const avgFillPrice = filledQuantity > 0 ? sumPxQty / filledQuantity : 0;

    let realizedPnlUsd = 0;
    if (filledQuantity > 0) {
      const { updated, realizedPnlUsd: realized } = this.applyPositionUpdate(
        request.symbol,
        request.side,
        filledQuantity,
        avgFillPrice,
      );
      realizedPnlUsd = realized;
      updated.updatedAt = executedAt;
      this.positions.set(updated.symbol, updated);
      this.db.upsertPosition(updated);
    }

    const order: OrderRecord = {
      clientOrderId: request.clientOrderId,
      exchangeOrderId: orderId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      filledQuantity,
      avgFillPrice,
      status,
      reason: status === 'partial' ? 'partial fill simulated' : undefined,
      createdAt: now,
      updatedAt: executedAt,
    };
    this.db.upsertOrder(order);
    for (const fill of fills) {
      this.db.insertFill(fill);
    }

    this.logger.info('paper order executed', {
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      avgFillPrice,
      realizedPnlUsd,
      status,
    });

    return {
      orderId,
      status,
      reason: order.reason,
      fills,
      filledQuantity,
      avgFillPrice,
      acceptedAt: executedAt,
      realizedPnlUsd,
      feesUsd: totalFees,
    };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const existing = this.db.getOrderByClientId(clientOrderId);
    if (!existing || existing.status === 'filled' || existing.status === 'rejected' || existing.status === 'canceled') {
      return;
    }
    this.db.upsertOrder({
      ...existing,
      status: 'canceled',
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const clampRate = (value: number): number => Math.max(0, Math.min(0.6, value));

const clampRatio = (value: number): number => Math.max(0.05, Math.min(1, value));

const randomBetween = (min: number, max: number): number => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return min;
  return min + Math.random() * (max - min);
};

const splitFillParts = (totalQty: number): number[] => {
  if (totalQty <= 0) return [];
  if (Math.random() < 0.5) return [totalQty];
  const first = totalQty * randomBetween(0.35, 0.75);
  return [first, Math.max(0, totalQty - first)];
};
