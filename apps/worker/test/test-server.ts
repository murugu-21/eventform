import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface ReceivedWebhook {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface TestServer {
  url: string;
  received: ReceivedWebhook[];
  /** Next responses return this status (sticky until changed). */
  setStatus: (status: number) => void;
  /** When set, the server delays responses by this many ms. */
  setDelayMs: (ms: number) => void;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const received: ReceivedWebhook[] = [];
  let status = 200;
  let delayMs = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      setTimeout(() => {
        res.statusCode = status;
        res.end(JSON.stringify({ ok: status < 300 }));
      }, delayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setStatus: (s) => (status = s),
    setDelayMs: (ms) => (delayMs = ms),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
