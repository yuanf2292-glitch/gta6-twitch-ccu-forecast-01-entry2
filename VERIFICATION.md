# gta6-twitch-ccu-forecast-01 — entry2 (fresh relay authoring, polished)

Fresh implementation written in a new session from
`gta6-twitch-ccu-forecast-01-design.md` (the prose spec). No reference
implementation file was opened. Method: log-space comparable profiles
(log-ratio to each launch's hour-1, clamped to ±4; pre-launch slope),
three candidate models (persistence, size-weighted analogue with Gaussian
kernel bandwidth 1 / no weight floor / shrink 0.9 / offset clamp 3.5,
pre-launch trend), model chosen by leave-one-launch-out pinball loss
(eligible if mean loss < persistence × 0.98 and wins ≥55% of launches).

## Validation (harness scorer, external-builder.py)
- Kit practice cases: 4/4 valid outputs, deterministic across two runs
  (byte-identical), 0.4s for 4 cases (~0.1s/case, well under the 8s cap).
- Synthetic validation set (37 independent launch days):
  mean pinball loss **0.532288** (target ≤ 0.70; reference 0.6607;
  starter baseline 0.9297). Typical miss 100.1%, 90% coverage 0.746.
  All 37 valid, 0 invalid. Official harness cross-check agrees exactly
  (0.532288).
- Big-hour-1 cases (hour-1 > 50,000, the GTA-VI-like group, 20 cases):
  mean 0.2054, max 0.4779 (Monster Hunter Wilds). No big-hour-1 case
  regressed more than 0.03 against the untuned relay version.
- Hardest cases remain the small-hour-1 launches (Hollow Knight:
  Silksong 2.04, Black Myth: Wukong 2.03), as expected from the design's
  size-ratio analysis — but both improved by ~0.5–0.8 from the untuned
  version (2.85 and 2.56).

## Polishing (this pass)
Untuned relay scored 0.663469. Three principled changes, each validated
by a coordinate scan on the 37-case set and checked for robustness
(split-half: even-index cases −0.176, odd-index cases −0.084; every size
tercile improved; 26 of 37 cases better, worst big-hour-1 regression
+0.029):
- **Weight floor 0.05 → 0**: pure size-weighting. The floor diluted the
  design's core insight (weight comparables by log hour-1 closeness) by
  giving distant-size launches a minimum weight. Removing it sharpens
  the pool to genuinely similar-size launches. Helps both big (0.2175 →
  0.2054) and small cases.
- **Shrink 0.65 → 0.9**: the analogue quantile was over-shrunk toward
  persistence (zero offset), underestimating the launch-day ratios. The
  scan is monotonic up to 0.9 and plateaus there; 0.9 is also the best
  point for the big-hour-1 group (1.0 is slightly worse there), so 0.9
  keeps a small safety margin instead of removing shrinkage entirely.
- **Offset clamp 2.5 → 3.5**: the old clamp truncated the upper tail of
  small-hour-1 launches (true log ratios run to ~7.7). Widening it lets
  the 95% quantile reach the observed ratios. It never binds for
  big-hour-1 cases (their ratios are small), so it costs nothing there.
- Unchanged and confirmed irrelevant / at their optimum: kernel
  bandwidth 1 (sweet spot; 0.75 and 1.5 both worse), ratio cap 4 (never
  binds), SIGMA (only affects persistence/trend; analogue is selected),
  model-selection thresholds (analogue wins clearly either way).

## Notes
- Single file `main.ts` (Node 22, standard library only). Deterministic,
  offline, no network. Malformed cases fall back to all-ones output.
- NOT submitted. Parent handles usage rows, bundling, gate check, submit.
