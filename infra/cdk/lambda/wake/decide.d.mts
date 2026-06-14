// Types for the plain-JS wake decision module (it ships as a Lambda asset, so it
// stays .mjs). Lets the vitest suite import it under the CDK package's tsc build.
export interface WakeDecision {
  action: "start" | "noop";
  desired: number;
  state: "starting" | "running" | "pending";
}
export function decideWake(asg: unknown): WakeDecision;
