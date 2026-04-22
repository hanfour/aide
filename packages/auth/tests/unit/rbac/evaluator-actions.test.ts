import { describe, it, expect } from "vitest";
import type { Action } from "../../../src/rbac/actions";

describe("RBAC — evaluator actions", () => {
  it("compiles with new capture / rubric / report / evaluator variants", () => {
    const samples: Action[] = [
      { type: "content_capture.read", orgId: "x" },
      { type: "content_capture.toggle", orgId: "x" },
      { type: "report.read_own" },
      { type: "report.read_user", orgId: "x", targetUserId: "u" },
      { type: "report.read_team", orgId: "x", teamId: "t" },
      { type: "report.read_org", orgId: "x" },
      {
        type: "report.rerun",
        orgId: "x",
        targetUserId: "u",
        periodStart: "2026-04-22",
      },
      { type: "report.export_own" },
      { type: "report.delete_own" },
      { type: "rubric.read", orgId: "x" },
      { type: "rubric.create", orgId: "x" },
      { type: "rubric.update", orgId: "x", rubricId: "r" },
      { type: "rubric.delete", orgId: "x", rubricId: "r" },
      { type: "evaluator.read_status", orgId: "x" },
    ];
    expect(samples.length).toBe(14);
  });
});
