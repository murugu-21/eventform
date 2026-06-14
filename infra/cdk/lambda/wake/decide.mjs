// Pure wake decision — no AWS imports, so it's unit-testable on its own.
// Given an ASG's current state, decide whether to nudge it back to desired=1.
export function decideWake(asg) {
  const desired = asg?.DesiredCapacity ?? 0;
  const inService = (asg?.Instances ?? []).some((i) => i.LifecycleState === "InService");
  if (desired < 1) {
    return { action: "start", desired: 1, state: "starting" };
  }
  // Already scaled up — running if an instance is in service, else still booting.
  return { action: "noop", desired, state: inService ? "running" : "pending" };
}
