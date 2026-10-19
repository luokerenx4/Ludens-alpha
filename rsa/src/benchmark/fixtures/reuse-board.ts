import { deflateSync } from "node:zlib";

// A tiny deterministic bitmap display keeps this fixture independent of a UI,
// browser, installed fonts, and the model's own filesystem tools.
const glyphs: Record<string, string> = {
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
  C: "01111100001000010000100001000001111", D: "11110100011000110001100011000111110",
  E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
  G: "01111100001000010111100011000101111", H: "10001100011000111111100011000110001",
  I: "11111001000010000100001000010011111", J: "00111000100001000010100101001001100",
  K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001110011010110011100011000110001",
  O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
  S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100",
  W: "10001100011000110101101011101110001", X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
  "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110",
  "2": "01110100010000100010001000100011111", "3": "11110000010000101110000010000111110",
  "4": "00010001100101010010111110001000010", "5": "11111100001000011110000010000111110",
  "6": "01110100001000011110100011000101110", "7": "11111000010001000100010000100001000",
  "8": "01110100011000101110100011000101110", "9": "01110100011000101111000010000101110",
  "/": "00001000100001000100010000100010000", ":": "00000001000010000000001000010000000",
  "-": "00000000000000011111000000000000000", ".": "00000000000000000000000000110001100",
};

function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type), content = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}

export interface BoardView {
  phase: number;
  order: number;
  completed: number;
  values: number[];
  target?: number[];
  waiting: boolean;
  done: boolean;
  notice: string;
}

export function renderBoard(view: BoardView): Buffer {
  const width = 960, height = 580, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  const rect = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
        const at = yy * stride + 1 + xx * 3;
        pixels[at] = color[0]!; pixels[at + 1] = color[1]!; pixels[at + 2] = color[2]!;
      }
    }
  };
  const text = (label: string, x: number, y: number, scale = 3, color = [226, 232, 240]) => {
    for (const char of label.toUpperCase()) {
      const glyph = glyphs[char];
      if (glyph) for (let i = 0; i < 35; i++) {
        if (glyph[i] === "1") rect(x + (i % 5) * scale, y + Math.floor(i / 5) * scale, scale, scale, color);
      }
      x += 6 * scale;
    }
  };
  rect(0, 0, width, height, [15, 23, 42]);
  text("ASSEMBLY BENCH", 38, 32, 5);
  text(`BATCH ${view.phase}/2   ORDER ${Math.min(view.order, 3)}/3   DONE ${view.completed}/6`, 38, 99);
  text("MATCH THE TARGET DIGITS AND SUBMIT EACH ORDER.", 38, 146, 3, [148, 163, 184]);
  for (let slot = 0; slot < 3; slot++) {
    const x = 50 + slot * 300;
    rect(x, 200, 258, 235, [30, 41, 59]);
    text(`SLOT ${slot + 1}`, x + 38, 221);
    text(`TARGET ${view.target?.[slot] ?? "-"}`, x + 38, 267, 3, [125, 211, 252]);
    text(String(view.values[slot]), x + 97, 321, 9);
  }
  const status = view.done ? "ALL ORDERS COMPLETE" : view.waiting ? "BATCH COMPLETE - RETURN TO RECEIVE NEXT BATCH" : view.notice;
  text(status.slice(0, 48), 38, 470, 3, [134, 239, 172]);
  text("TWO BATCHES ARRIVE IN SEQUENCE.", 38, 525, 3, [148, 163, 184]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
