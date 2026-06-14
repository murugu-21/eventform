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
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { decideWake } from "./decide.mjs";

const ASG_NAME = process.env.ASG_NAME;
const TOPIC_ARN = process.env.TOPIC_ARN;
const asg = new AutoScalingClient({});
const sns = new SNSClient({});

export async function handler(event) {
  if (!ASG_NAME) return json(500, { error: "ASG_NAME not configured" });

  const out = await asg.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [ASG_NAME] }),
  );
  const group = out.AutoScalingGroups?.[0];
  if (!group) return json(404, { error: "auto scaling group not found" });

  const decision = decideWake(group);
  if (decision.action === "start") {
    await asg.send(
      new SetDesiredCapacityCommand({ AutoScalingGroupName: ASG_NAME, DesiredCapacity: 1 }),
    );
    // Notify only on the real 0→1 transition — one email per cold start, not per
    // wake call (concurrent callers during boot get a no-op). Never fail the wake
    // on a notify error.
    await notifyStarted(event);
  }
  return json(200, { state: decision.state, desired: decision.desired });
}

async function notifyStarted(event) {
  if (!TOPIC_ARN) return;
  const who = userFrom(event);
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: `EventForm started by ${who}`.slice(0, 99),
        Message: `EventForm backend was woken from idle.\n\nUser:  ${who}\nWhen:  ${new Date().toISOString()}`,
      }),
    );
  } catch (e) {
    console.error("wake notify failed:", e?.message);
  }
}

function userFrom(event) {
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (body?.email) return String(body.email);
  } catch {
    /* malformed body — fall through to claims */
  }
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  return claims.email || claims.username || claims.sub || "an authenticated user";
}

function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
