import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

test('SDK paths remain filesystem paths when the checkout contains spaces and a Windows drive', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'keeper paths '))
  try {
    const oracleRoot = join(temporary, 'oracle with spaces')
    const moduleDirectory = join(oracleRoot, 'packages', 'oracle-sdk', 'src', 'abi')
    mkdirSync(moduleDirectory, { recursive: true })
    const modulePath = join(moduleDirectory, 'sources.ts')
    copyFileSync(new URL('../../../packages/oracle-sdk/src/abi/sources.ts', import.meta.url), modulePath)
    const paths = await import(pathToFileURL(modulePath).href)
    // Bun resolves imported modules through symlinks (macOS /var -> /private/var).
    const resolvedRoot = realpathSync(oracleRoot)
    expect(paths.ORACLE_ROOT).toBe(`${resolvedRoot}${sep}`)
    expect(paths.ABI_DIR).toBe(join(resolvedRoot, 'abi'))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
