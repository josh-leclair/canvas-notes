/** A stable hue per id, so a board keeps the same colour everywhere it
 * appears — in the canvas list, as a card, in a breadcrumb. */
export function hueFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

export function tintGradient(id: string): string {
  const pairs = [
    ["avocado", "maple"],
    ["maple", "rust"],
    ["cement", "maple"],
    ["plum", "rust"],
    ["maple", "avocado"],
    ["cement", "avocado"],
  ] as const;
  const [from, to] = pairs[hueFor(id) % pairs.length];
  return `linear-gradient(135deg, var(--hue-${from}) 0%, var(--hue-${to}) 100%)`;
}
