# RL Trading Reliability E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make RL training outcomes trustworthy by enforcing robust promotion gates, unified evaluation scorecards, and repeatable verification flow.

**Architecture:** Keep current runtime and training architecture, but harden promotion logic and expose one canonical evaluation snapshot used by training scripts and runtime checks. Prioritize safety-first defaults, then wire the snapshot into existing debug and training loops.

**Tech Stack:** Node.js 22, TypeScript, Fastify API, existing ML/RL modules (`MlService`, `ModelRegistry`, `RlTrainer`), CLI scripts.

## Execution status (2026-02-23)

- [x] Phase A: promotion hardening (RL simple-gate disabled by default)
- [x] Phase B: canonical scorecard in retrain response
- [x] Phase C: script integration (`train-until-target`, `verify-runtime-loop`)
- [x] Phase D: verification (`pnpm check`, `pnpm build`, runtime probe)
- [ ] Phase E: long-run training loop and threshold tuning from collected logs

---

### Task 1: Freeze The Execution Contract (Plan + Acceptance)

**Files:**
- Create: `docs/plans/2026-02-23-rl-trading-reliability-e2e.md`
- Modify: `README.md`

**Step 1: Add explicit acceptance criteria**

- Define minimum acceptance:
- No RL champion promotion via in-sample-only shortcut by default.
- One canonical evaluation scorecard is available after retrain.
- Training loop and debug verification consume the same scorecard fields.
- `pnpm check` and `pnpm build` pass.

**Step 2: Document rollout sequence**

- Phase A: promotion hardening.
- Phase B: evaluation scorecard.
- Phase C: script integration.
- Phase D: verification and logs.

---

### Task 2: Harden Promotion Gate For RL

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/ml/model-registry.ts`
- Modify: `src/ml/ml-service.ts`
- Modify: `.env.example`

**Step 1: Add config flag for RL simple-promotion**

- Add `ml.simplePromotionAllowRl` with default `false`.
- Add env var `ML_SIMPLE_PROMOTION_ALLOW_RL=false` to `.env.example`.

**Step 2: Restrict simple-promotion path in registry**

- In `ModelRegistry.evaluatePromotion`, apply simple-promotion path only when:
- simple-promotion enabled, and
- challenger is supervised, or RL simple-promotion explicitly allowed.

**Step 3: Pass flag from service to registry**

- Include `simplePromotionAllowRl` in `evaluatePromotion` calls in `MlService` (both supervised and RL branches).

**Step 4: Add reason text clarity**

- Ensure rejection/promotion reasons reflect whether simple gate was skipped for RL.

---

### Task 3: Add Canonical Retrain Evaluation Scorecard

**Files:**
- Modify: `src/ml/ml-service.ts`
- Modify: `src/api/server.ts` (if needed for response shape stability)

**Step 1: Build scorecard helper**

- Add internal helper in `MlService` that emits normalized scorecard:
- dataset/split metadata
- in-sample / walk-forward / holdout / unseen
- promotion gate inputs and thresholds
- final gate decision fields

**Step 2: Attach scorecard to retrain responses**

- Attach scorecard to `supervised` and `rl` retrain outputs.
- Keep backward-compatible existing fields.

**Step 3: Add scorecard schema consistency**

- Ensure absent sections return `null` or safe default values, not shape changes.

---

### Task 4: Integrate Scorecard Into E2E Scripts

**Files:**
- Modify: `scripts/train-until-target.mjs`
- Modify: `debug/verify-runtime-loop.mjs`

**Step 1: Consume scorecard in train loop**

- Read scorecard fields for decision logging and target checks.
- Add explicit logging of gate decision basis (wf/pf/dd/trades/unseen).

**Step 2: Extend runtime verify probe summary**

- Add scorecard summary fields to debug output, so runtime verification shows same gate basis.

**Step 3: Keep legacy compatibility**

- If scorecard absent (old server), fall back to legacy fields and print warning.

---

### Task 5: Verification

**Files:**
- No additional files required unless fixes discovered.

**Step 1: Type check**

Run: `pnpm check`  
Expected: success, zero TypeScript errors.

**Step 2: Build**

Run: `pnpm build`  
Expected: success, dist generated.

**Step 3: Runtime smoke**

Run: `node debug/verify-runtime-loop.mjs`  
Expected: health ok, backtest probe returned, registry probe returned, no script crash.

---

### Task 6: Operator Notes

**Files:**
- Modify: `README.md`

**Step 1: Add short operational guidance**

- Explain why RL simple-promotion is disabled by default.
- Explain where to inspect scorecard in retrain output.
- Explain required gate checks before enabling any live rollout.
