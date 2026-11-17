// gta6-twitch-ccu-forecast-01 — analogue launch-profile forecast.
//
// Forecasts Twitch concurrent viewers in the Grand Theft Auto VI category,
// hour by hour, for release day 2026-11-19, from one case file: the hour-1
// print, the pre-launch history, and 38 past big-game launches (comparables).
//
// Method, all in log space. Let p1 be the hour-1 print and logP = ln(p1).
//   1. Each comparable becomes a launch-day profile: for every release hour
//      offset 1..23, the log-ratio ln(viewers / first), first being that
//      launch's own hour-1 print, clamped to [-4, +4]; plus a pre-launch
//      slope (median hour-to-hour log change over offsets -5..0, each
//      clamped to +/-0.06/hour).
//   2. Three candidate models give five log-quantiles per hour:
//      - persistence: centre logP, spread 0.15 * sqrt(h-1);
//      - analogue: the size-weighted quantile of the comparables' log-ratios
//        at that hour (Gaussian kernel on log hour-1, bandwidth 1, no weight
//        floor), shrunk by 0.9 and clamped to [-3.5, +3.5], added to
//        logP; falls back to persistence when fewer than 6 comparables
//        carry that hour;
//      - trend: centre logP + (case's own pre-launch slope) * (h-1), same
//        spread as persistence.
//   3. The model is chosen by leave-one-launch-out pinball loss in ratio
//      space: a model must beat persistence by 2% on average and on at
//      least 55% of held-out launches to be eligible; otherwise persistence.
//      (On the validation set this picks the analogue.)
//   4. Output is {"hours": [...]} with 23 rows, hours 2..24, five
//      non-decreasing quantiles each, clamped to (0, 1e9]. A malformed case
//      still yields a valid file (all quantiles 1) instead of a crash.
//
// Node 22, standard library only, offline, deterministic: same input gives
// byte-identical output, well inside the 8-second case cap.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard-normal quantiles at the five levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Log-spread per square-root hour (persistence and trend). */
const SIGMA = 0.15;
/** Stored log-ratio clamp. */
const RATIO_CAP = 4;
/** Analogue offset clamp after shrinking. */
const OFFSET_CLAMP = 3.5;
/** Analogue shrink factor. */
const SHRINK = 0.9;
/** Gaussian kernel bandwidth on log hour-1 (natural-log units). */
const KERNEL_BW = 1;
/** Minimum weight for any comparable in the analogue pool. */
const WEIGHT_FLOOR = 0;
/** Minimum comparables carrying an hour for the analogue to use it. */
const MIN_ANALOGUE_N = 6;
/** Per-hour log-change clamp for pre-launch slopes. */
const SLOPE_CLAMP = 0.06;
/** Minimum profiles / scored launches for leave-one-out selection. */
const MIN_PROFILES = 10;
/** Minimum usable hours for a launch to be scored in leave-one-out. */
const MIN_USABLE_HOURS = 8;
/** Eligible if mean loss is below persistence mean times this factor. */
const ELIGIBLE_FACTOR = 0.98;
/** Eligible if it beats persistence on at least this share of launches. */
const ELIGIBLE_WIN_RATE = 0.55;

const HOUR_MS = 3600_000;

type HourlyPoint = { from: string; viewers: number };
type Comparable = {
  name: string;
  day_start: string;
  hourly: HourlyPoint[];
};
type CaseFile = {
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  history_hourly?: HourlyPoint[];
  day_start?: string;
  comparables?: Comparable[];
};

/** One comparable reduced to its launch-day shape. */
type Profile = {
  /** ln of its hour-1 print. */
  logFirst: number;
  /** log-ratio per release-hour offset 1..23 (only offsets with a print). */
  ratios: Map<number, number>;
  /** Pre-launch slope (median hourly log change, offsets -5..0). */
  slope: number;
};

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Median of a list (0 for an empty list). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Parse an ISO-8601 UTC timestamp to epoch milliseconds. */
function parseTime(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Weighted quantile (inverse weighted ECDF): the smallest value whose
 * cumulative weight reaches tau of the total. Deterministic.
 */
function weightedQuantile(pairs: Array<{ v: number; w: number }>, tau: number): number {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((acc, p) => acc + p.w, 0);
  if (total <= 0) return sorted[0].v;
  const target = tau * total;
  let cum = 0;
  for (const p of sorted) {
    cum += p.w;
    if (cum >= target) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

/** Pinball loss of one item, in log space: 2 * max(tau*d, (tau-1)*d). */
function pinball(tau: number, actualLog: number, predLog: number): number {
  const d = actualLog - predLog;
  return 2 * Math.max(tau * d, (tau - 1) * d);
}

/**
 * Reduce one comparable to a launch-day profile. Returns null when the
 * comparable cannot be used (no hour-1 print, or it is the GTA VI category
 * history rather than a launch).
 */
function buildProfile(comp: Comparable): Profile | null {
  const name = (comp.name ?? '').toLowerCase();
  if (name.includes('grand theft auto vi') || name.includes('gta vi')) return null;
  if (!comp.day_start || !Array.isArray(comp.hourly)) return null;
  const dayStart = parseTime(comp.day_start);
  if (!Number.isFinite(dayStart)) return null;

  // Bucket the hourly points by integer hour offset from day start.
  const byOffset = new Map<number, number>();
  for (const pt of comp.hourly) {
    if (!pt || typeof pt.viewers !== 'number' || !Number.isFinite(pt.viewers)) continue;
    const t = parseTime(pt.from);
    if (!Number.isFinite(t)) continue;
    const off = Math.round((t - dayStart) / HOUR_MS);
    if (!byOffset.has(off)) byOffset.set(off, pt.viewers);
  }
  const first = byOffset.get(0);
  if (first === undefined || first < 1) return null;
  const logFirst = Math.log(first);

  const ratios = new Map<number, number>();
  for (let off = 1; off <= 23; off++) {
    const v = byOffset.get(off);
    if (v === undefined || v < 1) continue;
    ratios.set(off, clamp(Math.log(v / first), -RATIO_CAP, RATIO_CAP));
  }

  // Pre-launch slope: median hourly log change over offsets -5..0.
  const changes: number[] = [];
  for (let off = -5; off < 0; off++) {
    const a = byOffset.get(off);
    const b = byOffset.get(off + 1);
    if (a === undefined || b === undefined || a < 1 || b < 1) continue;
    changes.push(clamp(Math.log(b / a), -SLOPE_CLAMP, SLOPE_CLAMP));
  }
  return { logFirst, ratios, slope: median(changes) };
}

/**
 * The case's own pre-launch slope: median hourly log change over the
 * 6 hours before day start plus the hour-1 point, each change clamped to
 * +/-0.06/hour. 0 when there are no usable consecutive pairs.
 */
function caseSlope(historyHourly: HourlyPoint[] | undefined, dayStartMs: number): number {
  if (!Array.isArray(historyHourly) || historyHourly.length === 0) return 0;
  const window: Array<{ t: number; v: number }> = [];
  for (const pt of historyHourly) {
    if (!pt || typeof pt.viewers !== 'number' || !Number.isFinite(pt.viewers)) continue;
    const t = parseTime(pt.from);
    if (!Number.isFinite(t)) continue;
    // The 6 hours before day start, plus the hour-1 point at day start.
    if (t >= dayStartMs - 6 * HOUR_MS && t <= dayStartMs) {
      window.push({ t, v: pt.viewers });
    }
  }
  window.sort((a, b) => a.t - b.t);
  const changes: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i].t - window[i - 1].t !== HOUR_MS) continue;
    if (window[i - 1].v < 1 || window[i].v < 1) continue;
    changes.push(clamp(Math.log(window[i].v / window[i - 1].v), -SLOPE_CLAMP, SLOPE_CLAMP));
  }
  return median(changes);
}

/** Gaussian kernel weight of a comparable for a given log hour-1. */
function kernelWeight(logFirst: number, refLog: number): number {
  const d = (logFirst - refLog) / KERNEL_BW;
  return Math.max(WEIGHT_FLOOR, Math.exp(-0.5 * d * d));
}

/**
 * The analogue's five log-ratio quantiles for one hour offset, from a pool
 * of profiles (already excluding any held-out launch). Returns null when
 * fewer than MIN_ANALOGUE_N profiles carry that offset.
 */
function analogueRatios(
  pool: Profile[],
  offset: number,
  refLog: number,
): number[] | null {
  const pairs: Array<{ v: number; w: number }> = [];
  for (const p of pool) {
    const r = p.ratios.get(offset);
    if (r === undefined) continue;
    pairs.push({ v: r, w: kernelWeight(p.logFirst, refLog) });
  }
  if (pairs.length < MIN_ANALOGUE_N) return null;
  return LEVELS.map((tau) =>
    clamp(SHRINK * weightedQuantile(pairs, tau), -OFFSET_CLAMP, OFFSET_CLAMP),
  );
}

/** Persistence log-quantiles for release hour h (centre logP). */
function persistenceLogs(logP: number, h: number): number[] {
  const s = SIGMA * Math.sqrt(h - 1);
  return Z.map((z) => logP + z * s);
}

/** Trend log-quantiles for release hour h (centre logP + slope*(h-1)). */
function trendLogs(logP: number, slope: number, h: number): number[] {
  const centre = logP + slope * (h - 1);
  const s = SIGMA * Math.sqrt(h - 1);
  return Z.map((z) => centre + z * s);
}

/**
 * Mean pinball loss of one model over one held-out launch, in ratio space
 * (centre 0; actuals are the launch's own log-ratios). `pool` excludes the
 * held-out launch. `model` is 'persistence' | 'analogue' | 'trend'.
 */
function looLoss(
  heldOut: Profile,
  pool: Profile[],
  model: 'persistence' | 'analogue' | 'trend',
): number | null {
  const offsets = [...heldOut.ratios.keys()].sort((a, b) => a - b);
  if (offsets.length < MIN_USABLE_HOURS) return null;
  let total = 0;
  let n = 0;
  for (const off of offsets) {
    const h = off + 1; // release hour
    const actual = heldOut.ratios.get(off) as number;
    let pred: number[];
    if (model === 'persistence') {
      pred = persistenceLogs(0, h);
    } else if (model === 'trend') {
      pred = trendLogs(0, heldOut.slope, h);
    } else {
      const ratios = analogueRatios(pool, off, heldOut.logFirst);
      pred = ratios ?? persistenceLogs(0, h);
    }
    for (let j = 0; j < LEVELS.length; j++) {
      total += pinball(LEVELS[j], actual, pred[j]);
      n++;
    }
  }
  return n > 0 ? total / n : null;
}

/**
 * Choose the model by leave-one-launch-out. Returns 'analogue' or 'trend'
 * only when it clearly beats persistence; otherwise 'persistence'.
 */
function selectModel(profiles: Profile[]): 'persistence' | 'analogue' | 'trend' {
  if (profiles.length < MIN_PROFILES) return 'persistence';
  const scored = profiles.filter((p) => p.ratios.size >= MIN_USABLE_HOURS);
  if (scored.length < MIN_PROFILES) return 'persistence';

  const losses: Record<'persistence' | 'analogue' | 'trend', number[]> = {
    persistence: [],
    analogue: [],
    trend: [],
  };
  for (const held of scored) {
    const pool = profiles.filter((p) => p !== held);
    for (const m of ['persistence', 'analogue', 'trend'] as const) {
      const l = looLoss(held, pool, m);
      if (l !== null) losses[m].push(l);
    }
  }
  if (losses.persistence.length < MIN_PROFILES) return 'persistence';
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const baseMean = mean(losses.persistence);
  let best: 'analogue' | 'trend' | null = null;
  let bestMean = Infinity;
  for (const m of ['analogue', 'trend'] as const) {
    if (losses[m].length < MIN_PROFILES) continue;
    const mMean = mean(losses[m]);
    let wins = 0;
    for (let i = 0; i < losses[m].length; i++) {
      if (losses[m][i] < losses.persistence[i]) wins++;
    }
    const winRate = wins / losses[m].length;
    if (mMean < baseMean * ELIGIBLE_FACTOR && winRate >= ELIGIBLE_WIN_RATE && mMean < bestMean) {
      best = m;
      bestMean = mMean;
    }
  }
  return best ?? 'persistence';
}

/** Round to 2 decimals (half up), matching the starter's output shape. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Fallback forecast: every quantile 1. */
function fallbackHours(): Array<{ hour: number; q: number[] }> {
  const hours: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) hours.push({ hour: h, q: [1, 1, 1, 1, 1] });
  return hours;
}

/** Forecast one case. Never throws: on any failure returns the fallback. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  try {
    if (!c || typeof c !== 'object') return fallbackHours();
    if (Array.isArray(c.levels)) {
      if (c.levels.length !== LEVELS.length) return fallbackHours();
      for (let j = 0; j < LEVELS.length; j++) {
        if (c.levels[j] !== LEVELS[j]) return fallbackHours();
      }
    }
    const first = Array.isArray(c.known) ? c.known.find((k) => k && k.hour === 1) : undefined;
    if (!first || typeof first.viewers !== 'number' || !Number.isFinite(first.viewers)) {
      return fallbackHours();
    }
    const p1 = Math.max(1, first.viewers);
    const logP = Math.log(p1);
    const hours = Array.isArray(c.forecast) ? c.forecast : [];
    if (hours.length === 0) return fallbackHours();

    // Comparable profiles.
    const profiles: Profile[] = [];
    if (Array.isArray(c.comparables)) {
      for (const comp of c.comparables) {
        const prof = buildProfile(comp as Comparable);
        if (prof) profiles.push(prof);
      }
    }

    // The case's own pre-launch slope.
    let dayStartMs = NaN;
    if (typeof c.day_start === 'string') dayStartMs = parseTime(c.day_start);
    const slope = Number.isFinite(dayStartMs)
      ? caseSlope(c.history_hourly, dayStartMs)
      : 0;

    const model = selectModel(profiles);

    const rows: Array<{ hour: number; q: number[] }> = [];
    for (const { hour: h } of hours) {
      if (typeof h !== 'number' || h < 2 || h > 24) continue;
      let logs: number[];
      if (model === 'analogue') {
        const ratios = analogueRatios(profiles, h - 1, logP);
        logs = ratios !== null
          ? ratios.map((r) => logP + r)
          : persistenceLogs(logP, h);
      } else if (model === 'trend') {
        logs = trendLogs(logP, slope, h);
      } else {
        logs = persistenceLogs(logP, h);
      }
      // Exponentiate, clamp to (0, 1e9], keep non-decreasing.
      const q: number[] = [];
      let prev = 0;
      for (const lg of logs) {
        let v = Math.exp(lg);
        if (!Number.isFinite(v) || v <= 0) v = 1;
        if (v > 1e9) v = 1e9;
        v = round2(v);
        if (v < prev) v = prev;
        if (v <= 0) v = 1;
        q.push(v);
        prev = v;
      }
      rows.push({ hour: h, q });
    }
    rows.sort((a, b) => a.hour - b.hour);
    if (rows.length !== 23) return fallbackHours();
    for (let i = 0; i < 23; i++) {
      if (rows[i].hour !== i + 2) return fallbackHours();
    }
    return rows;
  } catch {
    return fallbackHours();
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    hours = forecastCase(c);
  } catch {
    hours = fallbackHours();
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
