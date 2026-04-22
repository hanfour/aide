import type { Evidence } from "../signals/types.js";
import type { Signal } from "../rubric/schema.js";
import type { Metrics } from "../metrics/aggregator.js";

export interface SignalHit {
  id: string;
  type: Signal["type"];
  hit: boolean;
  value?: number;
  evidence?: Evidence[];
}

export interface SectionResult {
  sectionId: string;
  name: string;
  weight: number; // Parsed from "50%" → 50
  standardScore: number;
  superiorScore: number;
  score: number; // Final: standard or superior
  label: string;
  signals: SignalHit[];
}

export interface DataQuality {
  capturedRequests: number;
  missingBodies: number;
  truncatedBodies: number;
  totalRequests: number;
  coverageRatio: number;
}

export interface Report {
  totalScore: number; // Weighted aggregate, clamped to [0, 120]
  sectionScores: SectionResult[];
  signalsSummary: Metrics;
  dataQuality: DataQuality;
}
