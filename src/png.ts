/**
 * Just enough PNG to read Chromium's screenshots and write a marked-up copy,
 * so ra can measure pixels without an image dependency.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** Pixels as RGBA bytes, row by row. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Reads an 8-bit RGB or RGBA PNG, which is what Chromium writes. */
export function decodePng(file: Uint8Array): Image {
  if (SIGNATURE.some((byte, index) => file[index] !== byte)) throw new Error("Not a PNG file.");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= file.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(file[offset + 4]!, file[offset + 5]!, file[offset + 6]!, file[offset + 7]!);
    const start = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const colorType = file[start + 9];
      if (file[start + 8] !== 8 || (colorType !== 2 && colorType !== 6) || file[start + 12] !== 0) {
        throw new Error("Unsupported PNG: expected 8-bit RGB or RGBA without interlacing.");
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      parts.push(file.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (channels === 0) throw new Error("PNG has no header.");
  const raw = inflateSync(parts.length === 1 ? parts[0]! : Buffer.concat(parts));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const from = y * (stride + 1);
    const filter = raw[from];
    const line = raw.subarray(from + 1, from + 1 + stride);
    if (filter === 0) {
      current.set(line);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) current[i] = line[i]! + (i >= channels ? current[i - channels]! : 0);
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) current[i] = line[i]! + previous[i]!;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        current[i] = line[i]! + (((i >= channels ? current[i - channels]! : 0) + previous[i]!) >> 1);
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? current[i - channels]! : 0;
        const up = previous[i]!;
        const corner = i >= channels ? previous[i - channels]! : 0;
        const estimate = left + up - corner;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dCorner = Math.abs(estimate - corner);
        current[i] = line[i]! + (dLeft <= dUp && dLeft <= dCorner ? left : dUp <= dCorner ? up : corner);
      }
    } else {
      throw new Error(`Unsupported PNG filter ${String(filter)}.`);
    }
    const to = y * width * 4;
    if (channels === 4) {
      data.set(current, to);
    } else {
      for (let x = 0, i = 0, o = to; x < width; x++, i += 3, o += 4) {
        data[o] = current[i]!;
        data[o + 1] = current[i + 1]!;
        data[o + 2] = current[i + 2]!;
        data[o + 3] = 255;
      }
    }
    [previous, current] = [current, previous];
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, body.length + 8)), body.length + 8);
  return out;
}

/** Writes RGBA pixels as a PNG. */
export function encodePng(image: Image): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export interface PixelDifference {
  /** Share of the larger picture that changed, from 0 to 1. */
  ratio: number;
  /** Where the changes are, largest first. */
  areas: Rect[];
}

const CELL = 16;
/** Fewer changed pixels than this in a cell is rendering noise, not a change. */
const NOISE = 3;

/**
 * Compares two pictures. A pixel counts as changed when any channel moves by
 * more than `tolerance`; anything one picture has and the other lacks counts
 * as changed too. Changes are grouped into areas of touching 16px cells, and a
 * cell with only a pixel or two changed is left out.
 */
export function comparePixels(before: Image, after: Image, tolerance = 24): PixelDifference {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const counts = new Uint16Array(columns * rows);
  for (let y = 0; y < height; y++) {
    const inBoth = y < before.height && y < after.height;
    for (let x = 0; x < width; x++) {
      let differs = true;
      if (inBoth && x < before.width && x < after.width) {
        const a = (y * before.width + x) * 4;
        const b = (y * after.width + x) * 4;
        differs =
          Math.abs(before.data[a]! - after.data[b]!) > tolerance
          || Math.abs(before.data[a + 1]! - after.data[b + 1]!) > tolerance
          || Math.abs(before.data[a + 2]! - after.data[b + 2]!) > tolerance;
      }
      if (differs) counts[Math.floor(y / CELL) * columns + Math.floor(x / CELL)]!++;
    }
  }
  const cells = new Uint8Array(columns * rows);
  let changed = 0;
  for (let index = 0; index < counts.length; index++) {
    if (counts[index]! < NOISE) continue;
    cells[index] = 1;
    changed += counts[index]!;
  }
  const areas: Rect[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== 1) continue;
    let left = columns;
    let right = 0;
    let top = rows;
    let bottom = 0;
    const queue = [start];
    cells[start] = 2;
    while (queue.length > 0) {
      const cell = queue.pop()!;
      const cx = cell % columns;
      const cy = Math.floor(cell / columns);
      left = Math.min(left, cx);
      right = Math.max(right, cx);
      top = Math.min(top, cy);
      bottom = Math.max(bottom, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const next = ny * columns + nx;
          if (cells[next] === 1) {
            cells[next] = 2;
            queue.push(next);
          }
        }
      }
    }
    areas.push({
      x: left * CELL,
      y: top * CELL,
      width: Math.min(width, (right + 1) * CELL) - left * CELL,
      height: Math.min(height, (bottom + 1) * CELL) - top * CELL,
    });
  }
  areas.sort((a, b) => b.width * b.height - a.width * a.height);
  return { ratio: width * height === 0 ? 0 : changed / (width * height), areas };
}

/** Draws a 2px frame around each area, in place. */
export function frame(image: Image, areas: readonly Rect[], color: readonly [number, number, number] = [226, 0, 116]): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const at = (y * image.width + x) * 4;
    image.data[at] = color[0];
    image.data[at + 1] = color[1];
    image.data[at + 2] = color[2];
    image.data[at + 3] = 255;
  };
  for (const area of areas) {
    for (let thickness = 0; thickness < 2; thickness++) {
      const left = area.x - 1 - thickness;
      const right = area.x + area.width + thickness;
      const top = area.y - 1 - thickness;
      const bottom = area.y + area.height + thickness;
      for (let x = left; x <= right; x++) {
        put(x, top);
        put(x, bottom);
      }
      for (let y = top; y <= bottom; y++) {
        put(left, y);
        put(right, y);
      }
    }
  }
}
