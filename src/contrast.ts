/**
 * Text contrast measured from what was painted.
 *
 * The page is photographed twice, once as it is and once with every glyph
 * made transparent. The second picture is the true background under each
 * piece of text, whatever produced it: images, gradients, overlays, blends.
 * The first shows whether the text was painted there at all.
 */
import type { Image, Rect } from "./png.ts";

/** One piece of text, as the page inspector reported it. */
export interface TextSample {
  /** A short description of the element. */
  where: string;
  text: string;
  /** One line of the text, in page pixels. */
  box: Rect;
  /** The text colour with every opacity applied: red, green, blue (0-255) and alpha (0-1). */
  color: [number, number, number, number];
  /** Font size in pixels. */
  size: number;
  /** Font weight, 100 to 900. */
  weight: number;
}

export interface ContrastProblem {
  sample: TextSample;
  /** The measured ratio, such as 2.9 for 2.9:1. */
  ratio: number;
  /** The ratio this text needs. */
  needs: number;
  /** The text colour as painted, as #rrggbb. */
  text: string;
  /** The typical background behind it, as #rrggbb. */
  background: string;
}

type Rgb = [number, number, number];

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, as WCAG defines it. */
export function luminance(color: Rgb): number {
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ratio WCAG AA asks of text this size: 3 for large text, otherwise 4.5. */
export function neededRatio(size: number, weight: number): number {
  return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
}

export function hex(color: Rgb): string {
  return `#${color.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function blend(color: readonly number[], alpha: number, over: Rgb): Rgb {
  return [
    color[0]! * alpha + over[0] * (1 - alpha),
    color[1]! * alpha + over[1] * (1 - alpha),
    color[2]! * alpha + over[2] * (1 - alpha),
  ];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Finds text whose contrast is too low. Text is skipped, never guessed at,
 * when it was not painted where the page says (covered, clipped, off the
 * picture) or when the paint does not match its colour (something lies over
 * it, or a blend mode is at work).
 */
export function findLowContrast(samples: readonly TextSample[], painted: Image, bare: Image): ContrastProblem[] {
  const problems: ContrastProblem[] = [];
  const width = Math.min(painted.width, bare.width);
  const height = Math.min(painted.height, bare.height);
  for (const sample of samples) {
    const left = Math.max(0, Math.floor(sample.box.x));
    const top = Math.max(0, Math.floor(sample.box.y));
    const right = Math.min(width, Math.ceil(sample.box.x + sample.box.width));
    const bottom = Math.min(height, Math.ceil(sample.box.y + sample.box.height));
    if (right - left < 2 || bottom - top < 2) continue;
    const [red, green, blue, alpha] = sample.color;
    if (alpha <= 0.02) continue;

    // The pixel the glyphs changed most is the best view of the ink.
    let strongest = 0;
    let ink: Rgb | undefined;
    let under: Rgb | undefined;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const a = (y * painted.width + x) * 4;
        const b = (y * bare.width + x) * 4;
        const change =
          Math.abs(painted.data[a]! - bare.data[b]!)
          + Math.abs(painted.data[a + 1]! - bare.data[b + 1]!)
          + Math.abs(painted.data[a + 2]! - bare.data[b + 2]!);
        if (change > strongest) {
          strongest = change;
          ink = [painted.data[a]!, painted.data[a + 1]!, painted.data[a + 2]!];
          under = [bare.data[b]!, bare.data[b + 1]!, bare.data[b + 2]!];
        }
      }
    }
    // Nothing changed: the text is not what is painted here.
    if (ink === undefined || under === undefined || strongest < 12) continue;

    // The ink must lie between its background and its own colour. Anything
    // else means the text is not painted the way its style says.
    const expected = blend([red, green, blue], alpha, under);
    const span = distance(expected, under);
    if (span > 1) {
      const along =
        ((ink[0] - under[0]) * (expected[0] - under[0])
          + (ink[1] - under[1]) * (expected[1] - under[1])
          + (ink[2] - under[2]) * (expected[2] - under[2]))
        / (span * span);
      const nearest: Rgb = [
        under[0] + (expected[0] - under[0]) * along,
        under[1] + (expected[1] - under[1]) * along,
        under[2] + (expected[2] - under[2]) * along,
      ];
      if (along < 0.15 || along > 1.25 || distance(ink, nearest) > 40) continue;
    }

    // Judge against the whole background under the line, a sample at a time.
    const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 600)));
    const ratios: number[] = [];
    const backgrounds: Rgb[] = [];
    for (let y = top; y < bottom; y += step) {
      for (let x = left; x < right; x += step) {
        const b = (y * bare.width + x) * 4;
        const background: Rgb = [bare.data[b]!, bare.data[b + 1]!, bare.data[b + 2]!];
        backgrounds.push(background);
        ratios.push(contrastRatio(blend([red, green, blue], alpha, background), background));
      }
    }
    const order = ratios.map((_, index) => index).sort((a, b) => ratios[a]! - ratios[b]!);
    const needs = neededRatio(sample.size, sample.weight);
    // Three quarters of the background must be too close before it counts.
    if (ratios[order[Math.floor(order.length * 0.75)]!]! >= needs - 0.05) continue;
    const middle = order[Math.floor(order.length / 2)]!;
    const background = backgrounds[middle]!;
    problems.push({
      sample,
      ratio: Math.round(ratios[middle]! * 10) / 10,
      needs,
      text: hex(blend([red, green, blue], alpha, background)),
      background: hex(background),
    });
  }
  return problems;
}
