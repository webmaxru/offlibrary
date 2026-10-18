/** @internal */
export const now = (): number => Date.now();

/** @internal Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** @internal Resolve a URL against the current document / worker location. */
export function absoluteUrl(url: string): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  return new URL(url, base).href;
}

/**
 * Format a byte count for humans: `formatBytes(1536)` → `"1.5 KB"`.
 * Uses binary multiples (1 KB = 1024 bytes), like most OS file managers.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : Number(value.toFixed(decimals))} ${units[i]}`;
}
