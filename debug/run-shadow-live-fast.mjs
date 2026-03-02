const envOr = (key, fallback) => process.env[key] ?? fallback;

const overrides = {
  PROFILE_ID: envOr('PROFILE_ID', 'live-short-adaptive-fast'),
  PORT: envOr('PORT', '8652'),
  BASE_URL: envOr('BASE_URL', 'http://127.0.0.1:8652'),
  DB_PATH: envOr('DB_PATH', './debug/db/trader-live-short-adaptive-fast.db'),
  REPORT_PATH: envOr('REPORT_PATH', 'debug/shadow-report-live-short-adaptive-fast.json'),
  METADATA_PATH: envOr('METADATA_PATH', 'debug/runtime-profile-live-short-adaptive-fast.json'),
  MARKET_MODE: envOr('MARKET_MODE', 'binance'),
  ROLLOUT_MODE: envOr('ROLLOUT_MODE', 'paper'),
  PAPER_ONLY: envOr('PAPER_ONLY', 'true'),
  TARGET_TRADES: envOr('TARGET_TRADES', '1'),
  POLL_MS: envOr('POLL_MS', '3000'),
  START_TIMEOUT_MS: envOr('START_TIMEOUT_MS', '45000'),
  MAX_WAIT_MS: envOr('MAX_WAIT_MS', '120000'),
  USE_EXISTING_RUNTIME: envOr('USE_EXISTING_RUNTIME', '0'),
  MAX_ORDERS_PER_MINUTE: envOr('MAX_ORDERS_PER_MINUTE', '40'),
  COOLDOWN_LOSS_STREAK: envOr('COOLDOWN_LOSS_STREAK', '0'),
  COOLDOWN_LOSS_MINUTES: envOr('COOLDOWN_LOSS_MINUTES', '0'),
  RL_CONFIDENCE_GATE_ENABLED: envOr('RL_CONFIDENCE_GATE_ENABLED', 'true'),
  RL_CONFIDENCE_Q_GAP: envOr('RL_CONFIDENCE_Q_GAP', '0.01'),
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_ENABLED: envOr('RL_CONFIDENCE_Q_GAP_ADAPTIVE_ENABLED', 'true'),
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_QUANTILE: envOr('RL_CONFIDENCE_Q_GAP_ADAPTIVE_QUANTILE', '0.55'),
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_SCALE: envOr('RL_CONFIDENCE_Q_GAP_ADAPTIVE_SCALE', '0.8'),
  RL_CONFIDENCE_Q_GAP_MIN: envOr('RL_CONFIDENCE_Q_GAP_MIN', '0.0008'),
  RL_MIN_SIGNAL_STRENGTH: envOr('RL_MIN_SIGNAL_STRENGTH', '0'),
  RL_HOLD_FLATTEN_ENABLED: envOr('RL_HOLD_FLATTEN_ENABLED', 'false'),
  RL_MIN_HOLD_BARS: envOr('RL_MIN_HOLD_BARS', '3'),
  RL_FLIP_COOLDOWN_BARS: envOr('RL_FLIP_COOLDOWN_BARS', '1'),
  RL_MAX_POSITION_BARS: envOr('RL_MAX_POSITION_BARS', '6'),
  RL_SHADOW_GATE_REQUIRED_TIER: envOr('RL_SHADOW_GATE_REQUIRED_TIER', '1'),
  RL_SHADOW_GATE_MIN_PF: envOr('RL_SHADOW_GATE_MIN_PF', '0'),
  RL_SHADOW_GATE_MIN_NET_PNL_USD: envOr('RL_SHADOW_GATE_MIN_NET_PNL_USD', '-0.5'),
  RL_SHADOW_GATE_MAX_DD_PCT: envOr('RL_SHADOW_GATE_MAX_DD_PCT', '0.05'),
};

Object.assign(process.env, overrides);

await import('./run-shadow-isolated.mjs');
