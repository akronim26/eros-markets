import { defineConfig } from 'vitest/config'

// scripts/record.test.ts is a bun test (it drives anvil with the services' code); vitest runs test/ only.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
