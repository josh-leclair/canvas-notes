export interface ImageCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tall photo should not become a tower, and a panorama should not become a
 * sliver. Direct canvas paste and Smart Capture share these bounds so an
 * image has the same initial footprint regardless of how it arrived. */
export const IMAGE_MIN_HEIGHT = 120;
export const IMAGE_MAX_HEIGHT = 460;

export function fittedImageCardHeight(
  cardWidth: number,
  naturalWidth: number,
  naturalHeight: number,
  crop?: ImageCropRect
): number | null {
  if (
    !Number.isFinite(cardWidth) ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    cardWidth <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) return null;
  const visibleWidth = naturalWidth * (crop?.w ?? 1);
  const visibleHeight = naturalHeight * (crop?.h ?? 1);
  if (
    !Number.isFinite(visibleWidth) ||
    !Number.isFinite(visibleHeight) ||
    visibleWidth <= 0 ||
    visibleHeight <= 0
  ) return null;
  return Math.round(
    Math.min(
      IMAGE_MAX_HEIGHT,
      Math.max(IMAGE_MIN_HEIGHT, (cardWidth * visibleHeight) / visibleWidth)
    )
  );
}

export function fittedImageCardHeightFromPayload(
  cardWidth: number,
  payload: Record<string, unknown>
): number | null {
  const naturalWidth = Number(payload.image_width);
  const naturalHeight = Number(payload.image_height);
  const rawCrop = payload.crop;
  const crop = rawCrop && typeof rawCrop === "object"
    ? rawCrop as Partial<ImageCropRect>
    : undefined;
  const validCrop = crop &&
    typeof crop.x === "number" &&
    typeof crop.y === "number" &&
    typeof crop.w === "number" &&
    typeof crop.h === "number"
      ? crop as ImageCropRect
      : undefined;
  return fittedImageCardHeight(cardWidth, naturalWidth, naturalHeight, validCrop);
}
