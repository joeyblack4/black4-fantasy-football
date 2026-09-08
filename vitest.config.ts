import { defineConfig } from "vitest/config";

// Each file creates PostgreSQL schemas and pools. Bound file concurrency so a
// laptop test run does not compete with itself for hundreds of connections.
// Individual tests still exercise concurrent commands and racing transactions.
export default defineConfig({ test: { maxWorkers: 4 } });
