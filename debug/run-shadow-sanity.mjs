const overrides = {
  MARKET_MODE: 'mock',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  MOCK_CLOCK_OFFSET_MINUTES: '7200',
  TARGET_TRADES: '5',
  POLL_MS: '2000',
  MAX_WAIT_MS: '180000',
  USE_EXISTING_RUNTIME: '0',
  RL_CONFIDENCE_GATE_ENABLED: 'true',
  RL_CONFIDENCE_Q_GAP: '0.01',
  RL_MIN_HOLD_BARS: '0',
  RL_FLIP_COOLDOWN_BARS: '0',
  REPORT_PATH: 'debug/shadow-report-confidence-sanity-env.json',
};

Object.assign(process.env, overrides);

await import('./run-shadow-until-trades.mjs');
