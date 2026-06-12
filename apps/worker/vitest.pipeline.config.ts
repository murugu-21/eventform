import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Runs ONLY the full-CDC pipeline e2e (outbox → Debezium → Kafka → worker →
// webhook). Requires the full compose stack up + the connector RUNNING.
// Invoked via `pnpm test:pipeline`; kept out of the default suite because the
// cold consumer-group join + CDC latency make it timing-sensitive.
export default defineConfig({
  test: {
    include: ["test/pipeline.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
    }),
  ],
});
