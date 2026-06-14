import { describe, it, expect } from "vitest";
// Pure decision module from the wake Lambda asset (no AWS imports).
import { decideWake } from "../lambda/wake/decide.mjs";

describe("decideWake", () => {
  it("starts the box when desired capacity is 0", () => {
    expect(decideWake({ DesiredCapacity: 0, Instances: [] })).toEqual({
      action: "start",
      desired: 1,
      state: "starting",
    });
  });

  it("no-ops as 'running' when already up with an InService instance", () => {
    expect(
      decideWake({ DesiredCapacity: 1, Instances: [{ LifecycleState: "InService" }] }),
    ).toEqual({ action: "noop", desired: 1, state: "running" });
  });

  it("no-ops as 'pending' when desired is 1 but no instance is InService yet", () => {
    expect(
      decideWake({ DesiredCapacity: 1, Instances: [{ LifecycleState: "Pending" }] }),
    ).toEqual({ action: "noop", desired: 1, state: "pending" });
  });

  it("treats missing/empty fields as desired 0 → start (never strands the box off)", () => {
    expect(decideWake({}).action).toBe("start");
    expect(decideWake(undefined).action).toBe("start");
    expect(decideWake({ DesiredCapacity: 1 }).state).toBe("pending");
  });
});
