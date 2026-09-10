import type { Insight } from '@/lib/insights';

interface NightData {
  dateStr: string;
  durationHours?: number;
  sessionCount?: number;
  settings?: {
    deviceModel?: string;
    epap?: number;
    ipap?: number;
    pressureSupport?: number;
    papMode?: string;
    riseTime?: number | null;
    trigger?: string;
    cycle?: string;
    easyBreathe?: boolean;
    rampEnabled?: boolean | null;
    rampPressure?: number | null;
    humidifierLevel?: number | null;
    maskType?: string | null;
    autoSensitivity?: number;
  };
  glasgow: {
    overall: number;
    skew?: number;
    spike?: number;
    flatTop?: number;
    topHeavy?: number;
    multiPeak?: number;
    noPause?: number;
    inspirRate?: number;
    multiBreath?: number;
    variableAmp?: number;
  };
  wat: {
    flScore: number;
    regularityScore?: number;
    periodicityIndex?: number;
  };
  ned: {
    breathCount?: number;
    nedMean: number;
    nedP95?: number;
    fiMean?: number;
    mShapePct?: number;
    reraIndex?: number;
    reraCount?: number;
    h1NedMean?: number;
    h2NedMean?: number;
    combinedFLPct?: number;
    estimatedArousalIndex?: number;
  };
  oximetry?: {
    odi3: number;
    odi4: number;
    tBelow90: number;
    tBelow94: number;
    hrClin10: number;
    coupled3_10: number;
    coupledHRRatio: number;
    spo2Mean: number;
    spo2Min: number;
    hrMean: number;
    h1?: { odi3: number; hrClin10: number; tBelow94: number };
    h2?: { odi3: number; hrClin10: number; tBelow94: number };
  } | null;
  machineSummary?: {
    ahi?: number | null;
    hi?: number | null;
    oai?: number | null;
    cai?: number | null;
    reraIndex?: number | null;
    leak50?: number | null;
    leak95?: number | null;
  } | null;
}

interface GenerateParams {
  nights: NightData[];
  selectedNightIndex: number;
  deep?: boolean;
  nightNotes?: {
    caffeine?: string | null;
    alcohol?: string | null;
    congestion?: string | null;
    position?: string | null;
    stress?: string | null;
    exercise?: string | null;
    note?: string;
  } | null;
}

export function generateClinicalPatternInsights(params: GenerateParams): Insight[] {
  const { nights, selectedNightIndex, nightNotes } = params;
  const current = nights[selectedNightIndex] ?? nights[0];
  if (!current) return [];

  const insights: Insight[] = [];
  let idCounter = 1;
  const nextId = () => `ai-deep-${idCounter++}`;

  const g = current.glasgow;
  const w = current.wat;
  const n = current.ned;
  const ox = current.oximetry;
  const settings = current.settings;

  // 1. Glasgow Index breath shape analysis
  if (g.overall >= 3.5 || (g.flatTop && g.flatTop > 0.35)) {
    insights.push({
      id: nextId(),
      type: 'warning',
      title: 'Elevated Flow Limitation & Flattened Inspiratory Profiles',
      body: `Overall Glasgow Index is ${g.overall.toFixed(2)}${g.flatTop ? ` with prominent flat-top scoring (${g.flatTop.toFixed(2)})` : ''}, indicating persistent inspiratory airflow flattening.`,
      category: 'glasgow',
      context: 'Inspiratory flattening indicates elevated upper airway resistance during inspiration. Common contributing factors include sleep position, nasal resistance, or insufficient inspiratory pressure. Discuss these patterns with your clinician.',
    });
  } else if (g.overall < 2.0) {
    insights.push({
      id: nextId(),
      type: 'positive',
      title: 'Stable Inspiratory Breath Shape Morphology',
      body: `Glasgow Index of ${g.overall.toFixed(2)} reflects rounded, physiological inspiratory flow curves with minimal airflow limitation.`,
      category: 'glasgow',
    });
  } else {
    insights.push({
      id: nextId(),
      type: 'info',
      title: 'Mild Breath Shape Asymmetry',
      body: `Glasgow Index of ${g.overall.toFixed(2)} shows intermediate inspiratory flow dynamics with preserved tidal volume stability.`,
      category: 'glasgow',
    });
  }

  // 2. WAT Engine (FL Score & Periodicity)
  if (w.flScore >= 35) {
    insights.push({
      id: nextId(),
      type: 'warning',
      title: 'Elevated Wobble Analysis FL Score',
      body: `WAT FL Score of ${w.flScore.toFixed(1)}% indicates substantial flow limitation burden across analyzed respiratory cycles.`,
      category: 'wat',
      context: 'Elevated FL score reflects departure from normal sinusoidal breathing. Mask fit, nasal congestion, and pressure dynamics frequently influence this metric. Results should be reviewed with your clinician.',
    });
  } else {
    insights.push({
      id: nextId(),
      type: 'positive',
      title: 'Well-Controlled Flow Limitation Profile',
      body: `WAT FL Score is ${w.flScore.toFixed(1)}%, consistent with adequate airway patency throughout the night.`,
      category: 'wat',
    });
  }

  if (w.periodicityIndex !== undefined && w.periodicityIndex > 0.04) {
    insights.push({
      id: nextId(),
      type: 'actionable',
      title: 'Cyclic Ventilation Oscillation Observed',
      body: `Periodicity Index is ${w.periodicityIndex.toFixed(3)}, detecting cyclic waxing-waning ventilation patterns in the 30–100s band.`,
      category: 'wat',
      context: 'Periodic ventilation cycles may reflect ventilatory instability (loop gain) or sleep transitions. Discuss this pattern with your clinician to evaluate comfort and settings.',
    });
  }

  // 3. NED Engine (M-Shape & Negative Effort Dependence)
  if (n.mShapePct !== undefined && n.mShapePct > 15) {
    insights.push({
      id: nextId(),
      type: 'warning',
      title: 'Mid-Inspiratory Flow Collapse (M-Shapes)',
      body: `${n.mShapePct.toFixed(1)}% of breaths exhibit M-shaped morphology with mid-inspiratory flow dips, reflecting dynamic airway collapse.`,
      category: 'ned',
      context: 'M-shaped flow occurs when airway suction exceeds wall stability mid-breath. This pattern is characteristic of flow limitation and worth reviewing with your sleep specialist.',
    });
  }

  if (n.reraIndex !== undefined && n.reraIndex > 5) {
    insights.push({
      id: nextId(),
      type: 'actionable',
      title: 'Frequent Respiratory Effort-Related Arousals',
      body: `Estimated RERA Index is ${n.reraIndex.toFixed(1)}/hr across ${n.reraCount ?? 0} identified progressive limitation sequences.`,
      category: 'ned',
      context: 'Sequences of increasing inspiratory resistance terminated by recovery breaths suggest subtle sleep fragmentation. Discuss these findings with your clinician.',
    });
  }

  // 4. Temporal Patterns (H1 vs H2 Split)
  if (n.h1NedMean !== undefined && n.h2NedMean !== undefined) {
    const diff = n.h2NedMean - n.h1NedMean;
    if (Math.abs(diff) > 4) {
      const worsened = diff > 0 ? 'worsening in the second half' : 'higher limitation in the first half';
      insights.push({
        id: nextId(),
        type: 'actionable',
        title: `Temporal Asymmetry: ${diff > 0 ? 'H2 Flow Limitation Elevation' : 'H1 Resistance Elevation'}`,
        body: `NED shifted from ${n.h1NedMean.toFixed(1)}% in H1 to ${n.h2NedMean.toFixed(1)}% in H2 (${worsened}).`,
        category: 'temporal',
        context: 'Discrepancies between sleep halves often correspond to sleep stage changes (REM concentration in H2) or nocturnal position changes (supine vs lateral). Share this temporal trend with your clinician.',
      });
    }
  }

  // 5. Cross-Engine Correlation
  if (g.overall >= 3.0 && w.flScore >= 30) {
    insights.push({
      id: nextId(),
      type: 'actionable',
      title: 'Concordant Cross-Engine Flow Limitation Signature',
      body: `Both Glasgow (${g.overall.toFixed(2)}) and WAT FL Score (${w.flScore.toFixed(1)}%) independently confirm persistent inspiratory limitation.`,
      category: 'correlation',
      context: 'Dual-engine concordance increases confidence that airflow resistance is clinically meaningful and not an artifact of single-metric scoring. Discuss therapy optimization with your clinician.',
    });
  }

  // 6. Oximetry Integration (if available)
  if (ox) {
    if (ox.tBelow94 > 5 || ox.tBelow90 > 1) {
      insights.push({
        id: nextId(),
        type: 'warning',
        title: 'Sustained Nocturnal Desaturation (T<94%)',
        body: `Time below 94% SpO2 was ${ox.tBelow94.toFixed(1)}% with minimum SpO2 reaching ${ox.spo2Min.toFixed(0)}%.`,
        category: 'oximetry',
        context: 'Sustained desaturation in the absence of discrete obstructive spikes may indicate hypoventilation, positional clustering, or underlying respiratory conditions. A medical review is recommended.',
      });
    }

    if (ox.coupledHRRatio > 0.25) {
      insights.push({
        id: nextId(),
        type: 'actionable',
        title: 'Autonomic Heart Rate Coupling with Desaturations',
        body: `${(ox.coupledHRRatio * 100).toFixed(0)}% of desaturations were accompanied by autonomic pulse rate surges within ±30s.`,
        category: 'correlation',
        context: 'Coupled pulse surges reflect sympathetic nervous system activation following airway resistance events. Discuss cardiovascular-respiratory coupling with your clinician.',
      });
    }
  }

  // 7. Settings & Notes context
  if (nightNotes?.congestion && nightNotes.congestion !== 'none') {
    insights.push({
      id: nextId(),
      type: 'info',
      title: `User Context: ${nightNotes.congestion.toUpperCase()} Nasal Congestion Reported`,
      body: `Self-reported nasal congestion aligns with elevated upper airway resistance observed during the analysis period.`,
      category: 'therapy',
    });
  }

  if (settings?.papMode || settings?.epap !== undefined) {
    const mode = settings.papMode ?? 'PAP';
    const epap = settings.epap !== undefined ? `EPAP ${settings.epap} cmH2O` : '';
    const ipap = settings.ipap !== undefined ? `, IPAP ${settings.ipap} cmH2O` : '';
    insights.push({
      id: nextId(),
      type: 'info',
      title: `Therapy Context: ${mode} Settings`,
      body: `Machine delivered ${mode} therapy${epap ? ` (${epap}${ipap})` : ''}. Observed flow dynamics reflect response to these configured settings.`,
      category: 'therapy',
    });
  }

  return insights.slice(0, 8);
}
