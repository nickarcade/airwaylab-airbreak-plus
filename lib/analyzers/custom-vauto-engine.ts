// ============================================================
// AirwayLab — airbreak-plus Custom VAuto Analysis Engine
// Models and analyzes delivered therapy for sessions using
// airbreak-plus Custom VAuto firmware (m-kozlowski/airbreak-plus).
// Reconstructs breath-by-breath adaptive boost, expiratory relief (EPS),
// pre-trigger assist, and Max IPAP headroom/clipping.
// ============================================================

import type { CustomVAutoMetrics, MachineSettings } from '../types';

export interface BreathInfo {
  inspStart: number;
  expStart: number;
  inspEnd: number;
  ti: number;
  te: number;
  peakFlow: number;
  tidalVolume: number;
  peakPressure: number;
  endExpPressure: number;
}

// PID constants matching airbreak-plus patches/my_asv.h
const ASV_PID_P = 0.5;
const ASV_PID_I = 0.1;
const ASV_PID_D = 0.2;
const ASV_PID_MIN = 0.0;
const ASV_PID_MAX = 1.5;
const ASV_LOW = 0.94;
const ASV_HIGH = 0.96;
const TR_COEFF = 0.025; // moving average weight per valid breath

function clamp(val: number, minVal: number, maxVal: number): number {
  return Math.max(minVal, Math.min(maxVal, val));
}

function remap01c(s: number, start: number, end: number): number {
  if (Math.abs(end - start) < 1e-6) return 0;
  return clamp((s - start) / (end - start), 0.0, 1.0);
}

/**
 * Reconstructs airbreak-plus Custom VAuto metrics across a session.
 */
export function computeCustomVAutoMetrics(
  breaths: BreathInfo[],
  machineSettings: MachineSettings,
  _samplingRate: number
): CustomVAutoMetrics | null {
  const custom = machineSettings.customVAuto;
  if (!custom || !custom.enabled) {
    return null;
  }

  const basePs = machineSettings.pressureSupport > 0
    ? machineSettings.pressureSupport
    : (machineSettings.extendedSettings?.['S.VA.PS'] ?? 3.2);

  const minEpap = machineSettings.epap > 0
    ? machineSettings.epap
    : (machineSettings.extendedSettings?.['S.VA.MinEPAP'] ?? 8.8);

  const maxIpap = machineSettings.ipap > 0
    ? machineSettings.ipap
    : (machineSettings.extendedSettings?.['S.VA.MaxIPAP'] ?? 15.0);

  const asvMax = custom.asvMax;
  const sensMultiplier = custom.asvSensMultiplier;

  if (breaths.length < 10) {
    return null;
  }

  // Tracking state for ASV adaptive volume model
  let targetVol = 0.35; // moving target volume in liters
  let lastError = 0.0;
  let cumulativeError = 0.0;

  const deliveredBoosts: number[] = [];
  const effectivePsList: number[] = [];
  const epsReliefList: number[] = [];
  const maxIpapHeadroomList: number[] = [];

  let boostedBreaths = 0;
  let clippedBreaths = 0;
  let exceededBreaths = 0;
  let shortTiBreaths = 0;
  let preTriggerAssists = 0;

  for (let bIdx = 0; bIdx < breaths.length; bIdx++) {
    const b = breaths[bIdx]!;
    const ti = b.ti;
    const tv = b.tidalVolume;

    // Reset per-breath peak state on inspiration (matching airbreak-plus patches/my_asv.c)
    let finalIps = 0.0;

    // 1. Ti 0.7s Gate for EPS Expiratory Relief and Valid Breath Update
    const qualifiesForEps = ti >= 0.7;
    if (!qualifiesForEps) {
      shortTiBreaths++;
    }

    // 2. Adaptive Boost Simulation (matching my_asv.c)
    // Error is difference between current volume and moving reference volume
    let breathBoost = 0.0;
    if (asvMax > 0 && targetVol > 0.05) {
      const volRatio = tv / targetVol;
      // Below 0.94 -> request boost; Above 0.96 -> reduce boost
      const err = remap01c(volRatio, ASV_LOW, 0.4) - remap01c(volRatio, ASV_HIGH, 1.4);

      cumulativeError += ASV_PID_I * err;
      cumulativeError = clamp(cumulativeError, ASV_PID_MIN, ASV_PID_MAX);

      const pTerm = ASV_PID_P * err;
      const dTerm = ASV_PID_D * (err - lastError);
      lastError = err;

      const rawSignal = clamp(pTerm + cumulativeError + dTerm, ASV_PID_MIN, ASV_PID_MAX);
      const pidSignal = rawSignal * sensMultiplier;

      // airbreak-plus caps adaptive factor at 1.0 + 1.5 = 2.5
      // Boost is added above base pressure shape, capped by ASV Max
      const requestedBoost = pidSignal * (basePs * 0.8);
      breathBoost = clamp(requestedBoost, 0.0, asvMax);
      finalIps = basePs + breathBoost;
    } else {
      finalIps = basePs;
    }

    // 3. Headroom to Max IPAP Ceiling
    // Delivered IPAP = estimated EPAP + basePs + breathBoost
    const nominalIpap = minEpap + basePs + breathBoost;
    maxIpapHeadroomList.push(Math.max(0, maxIpap - nominalIpap));

    if (nominalIpap > maxIpap) {
      exceededBreaths++;
    }

    if (breathBoost > 0.1) {
      boostedBreaths++;
      // Check if Max IPAP clipped the boost
      if (nominalIpap >= maxIpap - 0.1) {
        clippedBreaths++;
        breathBoost = Math.max(0, maxIpap - (minEpap + basePs));
      }
    }

    deliveredBoosts.push(breathBoost);
    const effectivePs = basePs + breathBoost;
    effectivePsList.push(effectivePs);

    // 4. Expiratory Pressure Relief (EPS) calculation (from wrapper_limit_max_pdiff.c:L115 & custom_vauto.md)
    // In airbreak-plus:
    // relief = clamp(0.2 * (EPAP - PS/2), 0.4, 1.6)
    // relief = max(0, relief - 0.25 * (peak_support - PS))
    // The pre-ramp reference cmd_epap is EPAP + PS/2, so (cmd_epap - PS) = EPAP - PS/2.
    let epsRelief = 0.0;
    if (qualifiesForEps) {
      const nominalRelief = clamp((minEpap - basePs / 2.0) * 0.2, 0.4, 1.6);
      epsRelief = Math.max(0.0, nominalRelief - (breathBoost * 0.25));
    }
    epsReliefList.push(epsRelief);

    // 5. Pre-trigger assist: if customTriggerCycle is on and breath has rapid onset
    if (custom.customTriggerCycle && b.peakFlow > 15 && bIdx > 0) {
      preTriggerAssists++;
    }

    // Update moving reference target for valid breaths (Ti > 0.7s)
    if (qualifiesForEps && tv > 0.1 && tv < 1.2) {
      targetVol = targetVol + (tv - targetVol) * TR_COEFF;
    }
  }

  const total = breaths.length;
  deliveredBoosts.sort((a, b) => a - b);
  effectivePsList.sort((a, b) => a - b);
  epsReliefList.sort((a, b) => a - b);
  maxIpapHeadroomList.sort((a, b) => a - b);

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const percentile = (sorted: number[], p: number) => {
    if (sorted.length === 0) return 0;
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx]!;
  };

  return {
    active: true,
    asvBoostMean: round2(mean(deliveredBoosts)),
    asvBoostMax: round1(deliveredBoosts[deliveredBoosts.length - 1] ?? 0),
    boostedBreathPct: round1((boostedBreaths / total) * 100),
    maxIpapClippedPct: round1((clippedBreaths / total) * 100),
    maxIpapExceededPct: round1((exceededBreaths / total) * 100),
    epsReliefMean: round2(mean(epsReliefList)),
    epsReliefMax: round1(epsReliefList[epsReliefList.length - 1] ?? 0),
    effectivePsMedian: round1(percentile(effectivePsList, 50)),
    effectivePsP95: round1(percentile(effectivePsList, 95)),
    shortTiUnder07sPct: round1((shortTiBreaths / total) * 100),
    preTriggerAssistPct: round1((preTriggerAssists / total) * 100),
    maxIpapHeadroomMedian: round1(percentile(maxIpapHeadroomList, 50)),
  };
}
