import { createHash } from "node:crypto";

/** The public export of a named scene captured by the app's native renderer. */
export interface NativeScene {
  name: string;
  src: string;
  /** SHA-256 of the encoded image shipped to readers. */
  sha256: string;
  /** When supplied, the accessible description expected from the captured facts. */
  alt?: string;
}

export interface PublishedFigure {
  src: string | null;
  alt?: string | null;
}

/** Check the image in a particular guide slot against an independent native capture. */
export async function verifyNativeFigure(
  page: string,
  scene: NativeScene,
  figure: PublishedFigure | null | undefined,
  readAsset: (src: string) => Uint8Array | Promise<Uint8Array>,
): Promise<void> {
  const label = `${page} (${scene.name})`;
  if (!scene.src || !/^[a-f0-9]{64}$/u.test(scene.sha256)) {
    throw new Error(`${label}: the native capture needs an image source and a lowercase SHA-256 digest.`);
  }
  if (!figure) throw new Error(`${label}: the guide figure is missing.`);
  if (figure.src !== scene.src) {
    throw new Error(`${label}: expected image ${JSON.stringify(scene.src)}, found ${JSON.stringify(figure.src)}.`);
  }
  if (scene.alt !== undefined && figure.alt !== scene.alt) {
    throw new Error(`${label}: expected alt ${JSON.stringify(scene.alt)}, found ${JSON.stringify(figure.alt ?? null)}.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readAsset(figure.src);
  } catch (cause) {
    throw new Error(`${label}: could not read the published image ${figure.src}.`, { cause });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== scene.sha256) {
    throw new Error(`${label}: ${figure.src} has SHA-256 ${digest}, expected ${scene.sha256} from the native capture.`);
  }
}
