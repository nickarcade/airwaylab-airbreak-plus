import { describe, it, expect } from 'vitest';
import { parseCustomSettings, formatCustomVAutoSummary } from '@/lib/parsers/custom-settings-parser';
import { findCustomSettingsFile } from '@/lib/parsers/night-grouper';
import { computeCustomVAutoMetrics, type BreathInfo } from '@/lib/analyzers/custom-vauto-engine';
import type { MachineSettings } from '@/lib/types';

describe('airbreak-plus Custom Settings Parser', () => {
  const REAL_CSG_TGT = `
#LBH 50
#LBL 20
#LLH 64
#LLL 3C
#RPF 0001
#RCF BFE
#RXF 0000
#RDF 0000
#RPW 0000
#RCW 06
#RXW 0000
#RDW 0000
#RPH 0001
#RCH 06
#RXH 0001
#RDH 0000
#RPO 0001
#RCM 0C8
#RXM 0001
#RDM 0000
`;

  it('parses real CSG.tgt register dump accurately', () => {
    const res = parseCustomSettings(REAL_CSG_TGT);
    expect(res).not.toBeNull();
    expect(res?.enabled).toBe(true);
    expect(res?.asvMax).toBe(4.0); // 0xC8 = 200 / 50.0 = 4.0
    expect(res?.asvSens).toBe('Low');
    expect(res?.asvSensMultiplier).toBe(0.75);
    expect(res?.customTriggerCycle).toBe(true);
    expect(res?.squareWave).toBe(true);
    expect(res?.asvBackupRate).toBe(false);
  });

  it('returns null for empty or non-custom text', () => {
    expect(parseCustomSettings('')).toBeNull();
    expect(parseCustomSettings('Just some random text')).toBeNull();
    expect(parseCustomSettings('#UNKNOWN 1234')).toBeNull();
  });

  it('maps sensitivity levels correctly', () => {
    const testWithSens = (val: string) => parseCustomSettings(`#RPO 0001\n#RXM ${val}\n#RCM 0096`);
    expect(testWithSens('0000')?.asvSens).toBe('Very Low');
    expect(testWithSens('0000')?.asvSensMultiplier).toBe(0.5);

    expect(testWithSens('0001')?.asvSens).toBe('Low');
    expect(testWithSens('0001')?.asvSensMultiplier).toBe(0.75);

    expect(testWithSens('0002')?.asvSens).toBe('Med');
    expect(testWithSens('0002')?.asvSensMultiplier).toBe(1.0);

    expect(testWithSens('0003')?.asvSens).toBe('High');
    expect(testWithSens('0003')?.asvSensMultiplier).toBe(1.25);

    expect(testWithSens('0004')?.asvSens).toBe('Very High');
    expect(testWithSens('0004')?.asvSensMultiplier).toBe(1.5);
  });

  it('formats human-readable summary', () => {
    const parsed = parseCustomSettings(REAL_CSG_TGT)!;
    const summary = formatCustomVAutoSummary(parsed);
    expect(summary).toContain('Custom VAuto: Active');
    expect(summary).toContain('ASV Max: 4.0 cmH2O');
    expect(summary).toContain('ASV Sens: Low (0.75x)');
    expect(summary).toContain('Custom T/C: On');
  });
});

describe('findCustomSettingsFile helper', () => {
  it('identifies csg.tgt and csg.set case-insensitively', () => {
    const files = [
      { name: 'STR.edf', path: 'STR.edf' },
      { name: 'CSG.tgt', path: 'SETTINGS/CSG.tgt' },
    ];
    expect(findCustomSettingsFile(files)).toEqual({ name: 'CSG.tgt', path: 'SETTINGS/CSG.tgt' });

    const setFiles = [
      { name: 'csg.set', path: 'SETTINGS/csg.set' },
    ];
    expect(findCustomSettingsFile(setFiles)).toEqual({ name: 'csg.set', path: 'SETTINGS/csg.set' });
  });

  it('returns null when no CSG file is present', () => {
    const files = [{ name: 'STR.edf', path: 'STR.edf' }];
    expect(findCustomSettingsFile(files)).toBeNull();
  });
});

describe('Custom VAuto Analysis Engine', () => {
  const baseSettings: MachineSettings = {
    deviceModel: 'AirCurve 10 VAuto',
    epap: 9.7,
    ipap: 13.4,
    pressureSupport: 3.2,
    papMode: 'VAuto',
    riseTime: null,
    trigger: 'High',
    cycle: 'High',
    easyBreathe: true,
    settingsSource: 'extracted',
    customVAuto: {
      enabled: true,
      asvMax: 4.0,
      asvSens: 'Low',
      asvSensMultiplier: 0.75,
      customTriggerCycle: true,
      squareWave: true,
      asvBackupRate: false,
    },
  };

  function generateBreaths(count: number, ti = 1.6, tv = 0.4, peakFlow = 30): BreathInfo[] {
    const breaths: BreathInfo[] = [];
    for (let i = 0; i < count; i++) {
      breaths.push({
        inspStart: i * 100,
        expStart: i * 100 + 40,
        inspEnd: i * 100 + 100,
        ti,
        te: 2.4,
        peakFlow,
        tidalVolume: tv,
        peakPressure: 13.0,
        endExpPressure: 9.7,
      });
    }
    return breaths;
  }

  it('returns null when customVAuto is disabled or not present', () => {
    const disabledSettings = {
      ...baseSettings,
      customVAuto: { ...baseSettings.customVAuto!, enabled: false },
    };
    expect(computeCustomVAutoMetrics(generateBreaths(20), disabledSettings, 25)).toBeNull();
  });

  it('returns null when breath count is under 10', () => {
    expect(computeCustomVAutoMetrics(generateBreaths(5), baseSettings, 25)).toBeNull();
  });

  it('computes realistic metrics and detects Max IPAP clipping', () => {
    // Generate flow-limited small breaths that will trigger adaptive boost
    const breaths = generateBreaths(30, 1.6, 0.18, 25);
    const metrics = computeCustomVAutoMetrics(breaths, baseSettings, 25);

    expect(metrics).not.toBeNull();
    expect(metrics?.active).toBe(true);
    expect(metrics?.epsReliefMean).toBeGreaterThan(0.4);
    // Because epap (9.7) + basePs (3.2) = 12.9, and Max IPAP is 13.4, headroom is only 0.5 cmH2O!
    expect(metrics?.maxIpapHeadroomMedian).toBeLessThanOrEqual(0.5);
  });

  it('tracks short Ti under 0.7s failing EPS relief', () => {
    // All breaths with Ti = 0.5s (< 0.7s)
    const shortBreaths = generateBreaths(20, 0.5, 0.35, 25);
    const metrics = computeCustomVAutoMetrics(shortBreaths, baseSettings, 25);

    expect(metrics?.shortTiUnder07sPct).toBe(100);
    expect(metrics?.epsReliefMean).toBe(0); // Failed the 0.7s eligibility gate!
  });
});
