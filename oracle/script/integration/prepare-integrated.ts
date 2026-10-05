// Keep the executable alongside deployment scripts; implementation uses the
// e2e workspace's pinned viem dependency rather than an undeclared root package.
import { main } from '../../e2e/src/integrated-preflight.js'
await main()
