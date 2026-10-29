const timestampId = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3}))?Z(?:-[a-zA-Z0-9._-]+)?$/;

const shanghaiTime = (() => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", era: "short",
    });
  } catch { return null; }
})();

/** A readable date is optional metadata; the complete recorded ID remains the identity. */
export function runIdentity(id: string): { id: string; summary: string | null } {
  const unknown = { id, summary: null };
  const match = timestampId.exec(id);
  // `$` also matches before a final newline; canonical IDs must consume the entire input.
  if (!match || match[0] !== id || !shanghaiTime) return unknown;
  const utc = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5] ?? "000"}Z`;
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== utc) return unknown;
  try {
    const parts = Object.fromEntries(shanghaiTime.formatToParts(date).map(part => [part.type, part.value]));
    // This summary has no era field, so do not misrepresent an ISO year zero as AD year one.
    if (parts.era !== "AD" || ["year", "month", "day", "hour", "minute", "second"].some(key => !/^\d+$/.test(parts[key] ?? ""))) return unknown;
    const day = `${parts.year.padStart(4, "0")}/${parts.month.padStart(2, "0")}/${parts.day.padStart(2, "0")}`;
    const time = `${parts.hour.padStart(2, "0")}:${parts.minute.padStart(2, "0")}:${parts.second.padStart(2, "0")}`;
    return { id, summary: `${day} ${time}${match[5] === undefined ? "" : `.${match[5]}`}` };
  } catch { return unknown; }
}
