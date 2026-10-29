/** URLs prefill an unverified package only; validation claims stay in memory. */
export function driverCreationHref(spec: string): string {
  return "/?" + new URLSearchParams({ view: "workspaces", create: "1", driverPackage: spec }).toString();
}

