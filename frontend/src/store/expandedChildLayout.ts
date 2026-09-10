/** Geometry needed to make a set of expanding sibling cards readable. */
export interface ExpandedChildBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Space left between full-size sibling cards after they expand. */
export const EXPANDED_CHILD_GAP = 12;

function overlapsHorizontally(left: ExpandedChildBox, right: ExpandedChildBox) {
  return left.x < right.x + right.w && left.x + left.w > right.x;
}

interface IsotonicBlock {
  first: number;
  last: number;
  sum: number;
  count: number;
}

/**
 * Spread siblings only when their full-size rectangles would overlap.
 *
 * Cards in the same horizontal lane keep their visual order. Their vertical
 * positions are the least-squares closest non-overlapping positions, so the
 * group shares the adjustment instead of pinning the first card and pushing
 * every later card an ever-growing distance down the canvas.
 */
export function spreadExpandedChildren(
  boxes: ExpandedChildBox[],
  gap = EXPANDED_CHILD_GAP
): Map<string, { x: number; y: number }> {
  if (boxes.length < 2) return new Map();

  // Horizontal overlap is transitive for the purpose of a visual lane: if A
  // meets B and B meets C, all three need a stable shared vertical order.
  const parent = boxes.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (left: number, right: number) => {
    const a = root(left);
    const b = root(right);
    if (a !== b) parent[b] = a;
  };

  for (let left = 0; left < boxes.length; left++) {
    for (let right = left + 1; right < boxes.length; right++) {
      if (overlapsHorizontally(boxes[left], boxes[right])) join(left, right);
    }
  }

  const lanes = new Map<number, ExpandedChildBox[]>();
  boxes.forEach((box, index) => {
    const lane = lanes.get(root(index)) ?? [];
    lane.push(box);
    lanes.set(root(index), lane);
  });

  const positions = new Map<string, { x: number; y: number }>();
  for (const lane of lanes.values()) {
    if (lane.length < 2) continue;
    lane.sort(
      (left, right) =>
        left.y - right.y || left.x - right.x || left.id.localeCompare(right.id)
    );

    // With prefix[i] equal to the room required by every earlier card, the
    // no-overlap constraints become a simple non-decreasing sequence. Pool
    // Adjacent Violators gives its closest sequence without arbitrary nudges.
    const prefix: number[] = [0];
    for (let index = 1; index < lane.length; index++) {
      prefix[index] = prefix[index - 1] + lane[index - 1].h + gap;
    }
    const blocks: IsotonicBlock[] = [];
    lane.forEach((box, index) => {
      blocks.push({
        first: index,
        last: index,
        sum: box.y - prefix[index],
        count: 1,
      });
      while (blocks.length >= 2) {
        const right = blocks[blocks.length - 1];
        const left = blocks[blocks.length - 2];
        if (left.sum / left.count <= right.sum / right.count) break;
        blocks.splice(blocks.length - 2, 2, {
          first: left.first,
          last: right.last,
          sum: left.sum + right.sum,
          count: left.count + right.count,
        });
      }
    });

    for (const block of blocks) {
      const base = block.sum / block.count;
      for (let index = block.first; index <= block.last; index++) {
        const box = lane[index];
        const y = base + prefix[index];
        if (Math.abs(y - box.y) > 0.01) positions.set(box.id, { x: box.x, y });
      }
    }
  }

  return positions;
}
