const MiB = 1024 * 1024;
const positive = (value: string | undefined, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** Working budgets are estimates, not process RSS limits. Heap ceilings leave room for temporary copies. */
export function archiveBudget(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const cacheBytes = positive(env.RSA_DASHBOARD_INDEX_CACHE_BYTES, 256 * MiB);
  const buildBytes = positive(env.RSA_DASHBOARD_BUILD_BYTES, 2 * 1024 * MiB);
  return { cacheBytes, buildBytes,
    readerHeapMiB: Math.ceil(Math.max(1024, cacheBytes / MiB * 3 + 256)),
    builderHeapMiB: Math.ceil(Math.max(4096, buildBytes / MiB * 1.5 + 1024)) };
}
