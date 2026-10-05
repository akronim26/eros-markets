import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Disposable local fixtures only. Serialize source observation/delivery with book
// capture/inclusion so a delayed INDEX cannot rewrite the capture's checkpoint.
// A crashed owner leaves the lock behind: inspect the run instead of guessing.
export function tryLocalSamplingLock(path: string): (() => void) | null {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    // Windows can report sharing/delete-pending contention as EPERM/EACCES,
    // including the brief interval while another owner closes its lock file.
    // Treat it as occupied, never as permission to overwrite or remove a lock.
    if (['EEXIST', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try { writeFileSync(fd, identity); } finally { closeSync(fd); }
  return () => {
    if (readFileSync(path, 'utf8') !== identity) throw new Error('LOCAL_SAMPLING_LOCK_OWNER_CHANGED');
    unlinkSync(path);
  };
}

export async function withLocalSamplingLock<T>(path: string | undefined, action: () => Promise<T>): Promise<T> {
  if (!path) return action();
  const deadline = Date.now() + 30_000;
  let release = tryLocalSamplingLock(path);
  while (!release) {
    if (Date.now() >= deadline) throw new Error('LOCAL_SAMPLING_LOCK_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 50));
    release = tryLocalSamplingLock(path);
  }
  try { return await action(); } finally { release(); }
}
