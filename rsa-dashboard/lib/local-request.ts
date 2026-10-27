/** HTTP trust checks stay outside the archive worker. */
export function localRequest(request: Request, mutation = false) {
  const host = request.headers.get("host")?.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("只允许本地访问");
  if (mutation && request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host")}`)
    throw new Error("只允许同源控制请求");
}

export function errorResponse(error: unknown, fallback = 400) {
  const value = (error ?? {}) as Error & { status?: number; code?: string; progress?: unknown };
  return Response.json({ error: value.message ?? String(error),
    ...(value.code ? { code: value.code } : {}), ...(value.progress === undefined ? {} : { progress: value.progress }),
  }, { status: value.status ?? fallback, headers: { "Cache-Control": "no-store",
    ...([202, 409, 503].includes(value.status ?? 0) ? { "Retry-After": "1" } : {}) } });
}
