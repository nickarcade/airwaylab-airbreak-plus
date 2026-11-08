// ============================================================
// AirwayLab — airbreak-plus Custom Settings Parser
// Parses CSG.tgt / CSG.set persistent settings from ResMed SD cards
// running the airbreak-plus custom firmware payload.
// ============================================================

import type { CustomVAutoSettings, ASVSensitivityLabel } from '../types';

const SENSITIVITY_MAP: Record<number, { label: ASVSensitivityLabel; multiplier: number }> = {
  0: { label: 'Very Low', multiplier: 0.50 },
  1: { label: 'Low', multiplier: 0.75 },
  2: { label: 'Med', multiplier: 1.00 },
  3: { label: 'High', multiplier: 1.25 },
  4: { label: 'Very High', multiplier: 1.50 },
};

/**
 * Parse airbreak-plus CSG.tgt / CSG.set text into structured CustomVAutoSettings.
 * Format on SD card is ASCII text with lines like:
 *   #RPO 0001   (Custom VAuto On/Off)
 *   #RCM 0C8    (ASV Max in hex / 50.0 -> cmH2O)
 *   #RXM 0001   (ASV Sensitivity 0-4)
 *   #RPH 0001   (Custom T/C On/Off)
 *   #RPF 0001   (Square Wave On/Off)
 *   #RPW 0000   (ASV Backup Rate On/Off)
 *
 * Returns null if the text is empty or contains no airbreak-plus registers.
 */
export function parseCustomSettings(text: string): CustomVAutoSettings | null {
  if (!text || typeof text !== 'string') return null;

  const lines = text.split(/\r?\n/);
  const raw: Record<string, string | number> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) continue;

    const parts = trimmed.substring(1).trim().split(/\s+/);
    if (parts.length < 2) continue;

    const key = parts[0]!.toUpperCase();
    const valHex = parts[1]!;
    raw[key] = valHex;
  }

  // Check if any Custom VAuto or airbreak registers are present
  const hasCustomVAutoKey = 'RPO' in raw || 'RCM' in raw || 'RXM' in raw || 'RPH' in raw;
  if (!hasCustomVAutoKey && !('RPF' in raw) && !('RPW' in raw)) {
    return null;
  }

  // RPO: Custom VAuto toggle (0 = Off, 1 = On)
  const rpoRaw = raw['RPO'] !== undefined ? parseInt(String(raw['RPO']), 16) : 0;
  const enabled = rpoRaw === 1;

  // RCM: ASV Max (hex value / 50.0 -> cmH2O). Default in airbreak is 3.0 cmH2O (150 = 0x96)
  let asvMax = 3.0;
  if (raw['RCM'] !== undefined) {
    const rcmVal = parseInt(String(raw['RCM']), 16);
    if (!isNaN(rcmVal)) {
      asvMax = Math.round((rcmVal / 50.0) * 10) / 10;
    }
  }

  // RXM: ASV Sens (0: Very Low, 1: Low, 2: Med, 3: High, 4: Very High). Default is 2 (Med)
  let asvSensCode = 2;
  if (raw['RXM'] !== undefined) {
    const rxmVal = parseInt(String(raw['RXM']), 16);
    if (!isNaN(rxmVal) && rxmVal in SENSITIVITY_MAP) {
      asvSensCode = rxmVal;
    }
  }
  const sensInfo = SENSITIVITY_MAP[asvSensCode] ?? SENSITIVITY_MAP[2]!;

  // RPH: Custom Trigger/Cycle (0 = Off, 1 = On)
  const rphRaw = raw['RPH'] !== undefined ? parseInt(String(raw['RPH']), 16) : 0;
  const customTriggerCycle = rphRaw === 1;

  // RPF: Square Wave (0 = Off, 1 = On)
  const rpfRaw = raw['RPF'] !== undefined ? parseInt(String(raw['RPF']), 16) : 0;
  const squareWave = rpfRaw === 1;

  // RPW: ASV Backup Rate (0 = Off, 1 = On)
  const rpwRaw = raw['RPW'] !== undefined ? parseInt(String(raw['RPW']), 16) : 0;
  const asvBackupRate = rpwRaw === 1;

  // RSA: AutoEPAP (0 = Off, 1 = On)
  const autoEpap = raw['RSA'] !== undefined ? parseInt(String(raw['RSA']), 16) === 1 : undefined;

  // RDF: AutoEPAP Min EPAP (hex value / 50.0 -> cmH2O)
  let autoEpapMinEpap: number | undefined;
  if (raw['RDF'] !== undefined) {
    const rdfVal = parseInt(String(raw['RDF']), 16);
    if (!isNaN(rdfVal) && rdfVal > 0) {
      autoEpapMinEpap = Math.round((rdfVal / 50.0) * 10) / 10;
    }
  }

  // RDM: AutoEPAP Max EPAP (hex value / 50.0 -> cmH2O)
  let autoEpapMaxEpap: number | undefined;
  if (raw['RDM'] !== undefined) {
    const rdmVal = parseInt(String(raw['RDM']), 16);
    if (!isNaN(rdmVal) && rdmVal > 0) {
      autoEpapMaxEpap = Math.round((rdmVal / 50.0) * 10) / 10;
    }
  }

  // RCW: Fall Time (in 8ms ticks)
  let fallTime: number | undefined;
  if (raw['RCW'] !== undefined) {
    const rcwVal = parseInt(String(raw['RCW']), 16);
    if (!isNaN(rcwVal)) {
      fallTime = rcwVal;
    }
  }

  // RXW: ST iBR (0 = Off, 1 = On)
  const ibr = raw['RXW'] !== undefined ? parseInt(String(raw['RXW']), 16) === 1 : undefined;

  // RXF: Header Clock (0 = Off, 1 = On)
  const headerClock = raw['RXF'] !== undefined ? parseInt(String(raw['RXF']), 16) === 1 : undefined;

  // RXH: Monitoring (0 = Off, 1 = On)
  const monitoring = raw['RXH'] !== undefined ? parseInt(String(raw['RXH']), 16) === 1 : undefined;

  return {
    enabled,
    asvMax,
    asvSens: sensInfo.label,
    asvSensMultiplier: sensInfo.multiplier,
    customTriggerCycle,
    squareWave,
    asvBackupRate,
    autoEpap,
    autoEpapMinEpap,
    autoEpapMaxEpap,
    fallTime,
    ibr,
    headerClock,
    monitoring,
    rawSettings: raw,
  };
}

/**
 * Format a clinical summary of Custom VAuto settings.
 */
export function formatCustomVAutoSummary(settings: CustomVAutoSettings): string {
  if (!settings.enabled) {
    return 'Custom VAuto: Disabled (Stock VAuto pressure shaping)';
  }

  return (
    `Custom VAuto: Active | ASV Max: ${settings.asvMax.toFixed(1)} cmH2O | ` +
    `ASV Sens: ${settings.asvSens} (${settings.asvSensMultiplier.toFixed(2)}x) | ` +
    `Custom T/C: ${settings.customTriggerCycle ? 'On' : 'Off'} | ` +
    `Square Wave: ${settings.squareWave ? 'On' : 'Off'}`
  );
}
