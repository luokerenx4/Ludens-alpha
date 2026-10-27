/** Exercise the same finite-build readiness protocol as the browser client. */
export async function awaitArchive<T>(read: () => Promise<T>): Promise<T> {
  const until = Date.now() + 15_000;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if ((error as { code?: string }).code !== "ARCHIVE_PREPARING" || Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
