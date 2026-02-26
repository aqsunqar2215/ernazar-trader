export interface ExecutionCostInput {
  notionalUsd: number;
  turnover: number;
  feeBps: number;
  slippageBps: number;
  turnoverPenaltyBps?: number;
  volatility?: number;
  macdHistNorm?: number;
}

export interface ExecutionCostResult {
  slippageBps: number;
  feeCost: number;
  turnoverPenalty: number;
  totalCost: number;
}

export const computeExecutionCosts = (input: ExecutionCostInput): ExecutionCostResult => {
  const volImpact = Math.max(0, input.volatility ?? 0) * 8;
  const macdImpact = Math.max(0, input.macdHistNorm ?? 0) * 2;
  const dynamicSlippageBps = input.slippageBps + volImpact + macdImpact;
  const turnoverPenaltyBps = input.turnoverPenaltyBps ?? 0;
  const feeCost = input.notionalUsd * ((input.feeBps + dynamicSlippageBps) / 10_000) * input.turnover;
  const turnoverPenalty = input.notionalUsd * (turnoverPenaltyBps / 10_000) * input.turnover;
  return {
    slippageBps: dynamicSlippageBps,
    feeCost,
    turnoverPenalty,
    totalCost: feeCost + turnoverPenalty,
  };
};
