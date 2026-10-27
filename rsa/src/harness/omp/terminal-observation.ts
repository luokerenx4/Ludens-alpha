import { encodeTerminalImage, TerminalGraphicsDecoder } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";
import { observationBytes, perceptionMetadata, type DeriveMedia, type PerceptionRead } from "../perception.ts";

// Match OMP's terminal graphics limits: reject a page before writing anything,
// rather than letting the decoder silently discard part of a historical view.
const MAX_IMAGES = 32;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const smallerPage = "Use a smaller --limit and continue with --after; no images were emitted.";

export async function terminalObservation(read: PerceptionRead, derive?: DeriveMedia): Promise<string> {
  const output = [JSON.stringify(perceptionMetadata(read, true), null, 2)];
  if (read.result.exitCode !== 0) return output[0]!;
  const entries = read.records
    ? read.records.flatMap(record => record.observations.map(observation => ({ observation, snapshot: record.snapshot })))
    : read.result.observations?.map(observation => ({ observation, snapshot: read.snapshot })) ?? [];
  const images = entries.filter(({ observation }) => observation.mediaType.startsWith("image/"));
  if (images.length > MAX_IMAGES) throw new Error(`Observation page has ${images.length} images; OMP accepts at most ${MAX_IMAGES}. ${smallerPage}`);
  let bytes = 0;
  for (const [index, { observation, snapshot }] of images.entries()) {
    // Count PNG bytes, the actual wire format, rather than the source's possibly
    // compressed JPEG/WebP size. OMP's encoder validates dimensions and chunks it.
    const png = await new Bun.Image(await observationBytes(observation), { maxPixels: 4 * 1024 * 1024 }).png().bytes();
    bytes += png.byteLength;
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`Observation page exceeds OMP's 40 MiB image limit. ${smallerPage}`);
    const encoded = await encodeTerminalImage({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
    const source = observation.timeline;
    if (derive && source?.recordId && source.sequence !== undefined) {
      try {
        // Record what OMP's terminal decoder actually returns, not the source
        // PNG or a guessed later model-specific normalization.
        const decoder = new TerminalGraphicsDecoder();
        decoder.push(encoded); decoder.finish();
        const [image] = await decoder.images();
        if (image) await derive({ source: { asset: source.asset, recordId: source.recordId, sequence: source.sequence },
          data: image.data, mediaType: image.mimeType, transform: "omp.terminalGraphics" }, observation.id);
      } catch (error) {
        // The displayed image is still valid even if its record has expired.
        console.error(`Timeline media reference unavailable: ${String(error)}`);
      }
    }
    output.push(`Image ${index + 1}: ${observation.id}${snapshot ? ` | observation #${snapshot.sequence} recordedAt=${snapshot.recordedAt}` : ""}`, encoded);
  }
  return output.join("\n");
}
