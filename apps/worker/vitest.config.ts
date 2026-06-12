import swc from "unplugin-swc";
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // pipeline.e2e is a full-CDC roundtrip (Kafka + Debezium) — timing-sensitive
    // and boots a real consumer. It runs via `pnpm test:pipeline` (own config) so
    // the default suite stays deterministic. The roundtrip is also covered
    // end-to-end by the Playwright smoke in CI.
    exclude: [...configDefaults.exclude, "test/pipeline.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    passWithNoTests: true,
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
