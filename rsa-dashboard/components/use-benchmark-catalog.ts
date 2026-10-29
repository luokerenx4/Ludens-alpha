"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/locale";
import type { BenchmarkCatalog } from "@/lib/benchmarks";
import { benchmarkCatalogOwner, benchmarkTaskMetadata, retainedBenchmarkMetadata,
  type BenchmarkCatalogOwnership, type BenchmarkMetadataSnapshot } from "@/lib/benchmark-catalog-state";
import { useBenchmarkRead } from "./use-benchmark-read";

/** Keep same-workspace navigation stable without treating old history as the current query. */
export function useBenchmarkCatalog(url: string | null, ownership: BenchmarkCatalogOwnership | null, refresh = false) {
  const t = useTranslations("benchmarkCases");
  const owner = benchmarkCatalogOwner(ownership);
  const [snapshot, setSnapshot] = useState<BenchmarkMetadataSnapshot | null>(null);
  useEffect(() => { setSnapshot(previous => previous?.owner === owner ? previous : null); }, [owner]);
  const read = useBenchmarkRead<BenchmarkCatalog>(owner ? url : null, refresh, {
    identity: owner ?? "",
    onValue(value) {
      const metadata = ownership && benchmarkTaskMetadata(value, ownership);
      if (!metadata || !owner || !url) throw new Error(t("catalogScopeChanged"));
      setSnapshot({ owner, url, metadata });
    },
  });
  return { ...read, ...retainedBenchmarkMetadata(snapshot, ownership, url, read.error, !!read.value) };
}
