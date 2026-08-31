/** Does this picture actually have transparency in it?
 *
 * Asked so an image card can drop its own surface and let a cut-out sit
 * directly on the canvas. The answer has to be about the *pixels*, not the
 * format: a screenshot saved as a PNG is a normal opaque picture and must
 * keep its card, and going by mime type alone would strip the frame off
 * every one of them.
 *
 * Answered in the browser rather than at upload. The file is same-origin, so
 * a canvas can read it back untainted, and the image has already been decoded
 * to be shown — measuring it costs one draw into a thumbnail-sized buffer.
 * The alternative was decoding five image formats on the server, which would
 * mean a new dependency for a question the client can already answer.
 */

/** The check runs against a small copy. A transparent region worth losing the
 *  card over is never one pixel wide, and 64x64 is enough to see one. */
const SAMPLE = 64;

/** How much of the picture has to be see-through before it counts.
 *
 *  Not "any pixel at all": an opaque photo with softened corners, or one
 *  re-encoded with a hairline of edge alpha, is still a photo and still wants
 *  its frame. A real cut-out is mostly background. */
const MIN_TRANSPARENT_FRACTION = 0.02;

/** Alpha below this is treated as see-through rather than as rounding. */
const OPAQUE = 250;

/** Formats that cannot carry an alpha channel at all, so there is nothing to
 *  measure and no reason to touch a canvas. */
const OPAQUE_TYPES = new Set(["image/jpeg", "image/jpg"]);

/** Keyed by src: the answer cannot change while the file exists, and cards
 *  re-render constantly — every drag frame remounts nothing but re-runs
 *  plenty. A cached answer is also what stops a card flickering back to
 *  framed when you revisit the canvas. */
const answers = new Map<string, boolean>();

export function knownAlpha(src: string): boolean | undefined {
  return answers.get(src);
}

export function couldHaveAlpha(mime: string | undefined): boolean {
  return !mime || !OPAQUE_TYPES.has(mime.toLowerCase());
}

/** Measure a loaded image. Returns false for anything it cannot read, so a
 *  failure keeps the card it already had rather than stripping it. */
export function detectAlpha(img: HTMLImageElement, src: string): boolean {
  const cached = answers.get(src);
  if (cached !== undefined) return cached;

  let transparent = false;
  try {
    // An SVG with no intrinsic size reports 0, so fall back rather than
    // asking for a zero-sized canvas.
    const width = Math.max(1, Math.min(SAMPLE, img.naturalWidth || SAMPLE));
    const height = Math.max(1, Math.min(SAMPLE, img.naturalHeight || SAMPLE));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);
      let seeThrough = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < OPAQUE) seeThrough++;
      }
      transparent = seeThrough / (width * height) >= MIN_TRANSPARENT_FRACTION;
    }
  } catch {
    // A tainted canvas or a format the browser will not decode: not an error
    // worth surfacing, just a picture that keeps its card.
    transparent = false;
  }

  answers.set(src, transparent);
  return transparent;
}
