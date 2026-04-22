import { describe, it, expect } from "vitest";
import { collectThreshold } from "../../src/signals/threshold";

describe("collectThreshold", () => {
  it("hits when metric >= gte", () => {
    expect(collectThreshold({ metricValue: 0.5, gte: 0.2 }).hit).toBe(true);
    expect(collectThreshold({ metricValue: 0.1, gte: 0.2 }).hit).toBe(false);
  });

  it("hits when metric <= lte", () => {
    expect(collectThreshold({ metricValue: 0.1, lte: 0.2 }).hit).toBe(true);
    expect(collectThreshold({ metricValue: 0.3, lte: 0.2 }).hit).toBe(false);
  });

  it("hits when value in between range inclusive", () => {
    expect(
      collectThreshold({ metricValue: 5, between: [1, 10] }).hit,
    ).toBe(true);
    expect(collectThreshold({ metricValue: 5, between: [10, 20] }).hit).toBe(
      false,
    );
    expect(collectThreshold({ metricValue: 1, between: [1, 10] }).hit).toBe(
      true,
    ); // boundary
    expect(collectThreshold({ metricValue: 10, between: [1, 10] }).hit).toBe(
      true,
    ); // boundary
  });

  it("returns no hit when no predicate provided", () => {
    expect(collectThreshold({ metricValue: 5 }).hit).toBe(false);
  });

  it("hits only when BOTH gte and lte satisfied", () => {
    expect(
      collectThreshold({ metricValue: 5, gte: 1, lte: 10 }).hit,
    ).toBe(true);
    expect(collectThreshold({ metricValue: 15, gte: 1, lte: 10 }).hit).toBe(
      false,
    );
  });

  it("returns metricValue as value on every call", () => {
    expect(collectThreshold({ metricValue: 42, gte: 0 }).value).toBe(42);
  });
});
