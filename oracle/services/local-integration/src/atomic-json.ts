import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'

/** Keep the last complete journal visible while transient Windows readers close. */
export function replaceWithRetry(source: string, destination: string,
  rename: (source: string, destination: string) => void = renameSync,
  wait: (ms: number) => void = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let attempt = 0; ; ++attempt) {
    try { rename(source, destination); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 99) throw error
      wait(10)
    }
  }
}

export function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`
  const descriptor = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(descriptor, JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n')
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  replaceWithRetry(temporary, path)
}
