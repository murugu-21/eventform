// EventForm wake handler. A logged-in user's SPA calls this (via API Gateway +
// a Cognito JWT authorizer) when the backend is off; it nudges the ASG to
// desired=1 so a fresh instance launches and boots the stack. Idempotent:
// setting desired=1 when it's already 1 is a no-op. AWS SDK v3 is provided by
// the Lambda Node.js runtime — no bundled dependency.
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { decideWake } from "./decide.mjs";

const ASG_NAME = process.env.ASG_NAME;
const client = new AutoScalingClient({});

export async function handler() {
  if (!ASG_NAME) return json(500, { error: "ASG_NAME not configured" });

  const out = await client.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [ASG_NAME] }),
  );
  const asg = out.AutoScalingGroups?.[0];
  if (!asg) return json(404, { error: "auto scaling group not found" });

  const decision = decideWake(asg);
  if (decision.action === "start") {
    await client.send(
      new SetDesiredCapacityCommand({ AutoScalingGroupName: ASG_NAME, DesiredCapacity: 1 }),
    );
  }
  return json(200, { state: decision.state, desired: decision.desired });
}

function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
