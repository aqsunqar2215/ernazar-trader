import type { BrokerOrderRequest, BrokerOrderResult, Position } from '../core/types.js';

export interface Broker {
  placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResult>;
  cancelOrder(clientOrderId: string): Promise<void>;
  getOpenPositions(): Promise<Position[]>;
  reconcile(): Promise<void>;
}
