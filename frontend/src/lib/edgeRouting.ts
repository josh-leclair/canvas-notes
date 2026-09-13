export type RouteSide = "top" | "right" | "bottom" | "left";

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeRouteRequest {
  id: string;
  sourceId: string;
  targetId: string;
  source: RouteBox;
  target: RouteBox;
  sourceSide: RouteSide;
  targetSide: RouteSide;
}

export interface EdgeRouteGeometry {
  points: RoutePoint[];
  label: RoutePoint;
}

const ESCAPE = 20;
const OBSTACLE_GAP = 14;
const LANE_STEP = 14;
const ROUTE_SEARCH_MARGIN = 180;
const EPSILON = 0.01;

function center(box: RouteBox): RoutePoint {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Choose sides from the empty space between rectangles, rather than from
 * their centres. A very wide heading can contain a child's centre far to its
 * left, but when that child is below the heading the useful exit is still the
 * bottom edge. */
export function facingRouteSides(
  source: RouteBox,
  target: RouteBox
): [RouteSide, RouteSide] {
  const sourceRight = source.x + source.w;
  const sourceBottom = source.y + source.h;
  const targetRight = target.x + target.w;
  const targetBottom = target.y + target.h;
  const overlapsX = source.x < targetRight && target.x < sourceRight;
  const overlapsY = source.y < targetBottom && target.y < sourceBottom;

  if (overlapsX && target.y >= sourceBottom) return ["bottom", "top"];
  if (overlapsX && targetBottom <= source.y) return ["top", "bottom"];
  if (overlapsY && target.x >= sourceRight) return ["right", "left"];
  if (overlapsY && targetRight <= source.x) return ["left", "right"];

  // Diagonal boxes have two legitimate exits. Prefer the axis with the
  // smaller edge-to-edge gap; it makes the short first leg point into open
  // space instead of curling around the source.
  const horizontalGap =
    target.x >= sourceRight
      ? target.x - sourceRight
      : source.x >= targetRight
        ? source.x - targetRight
        : 0;
  const verticalGap =
    target.y >= sourceBottom
      ? target.y - sourceBottom
      : source.y >= targetBottom
        ? source.y - targetBottom
        : 0;

  if (verticalGap <= horizontalGap && verticalGap > 0) {
    return center(target).y >= center(source).y
      ? ["bottom", "top"]
      : ["top", "bottom"];
  }
  if (horizontalGap > 0) {
    return center(target).x >= center(source).x
      ? ["right", "left"]
      : ["left", "right"];
  }

  const a = center(source);
  const b = center(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function portPoint(box: RouteBox, side: RouteSide, axis: number): RoutePoint {
  if (side === "top") return { x: axis, y: box.y };
  if (side === "bottom") return { x: axis, y: box.y + box.h };
  if (side === "left") return { x: box.x, y: axis };
  return { x: box.x + box.w, y: axis };
}

function centrePort(box: RouteBox, side: RouteSide): RoutePoint {
  const boxCenter = center(box);
  return portPoint(
    box,
    side,
    side === "left" || side === "right" ? boxCenter.y : boxCenter.x
  );
}

function escapePoint(point: RoutePoint, side: RouteSide): RoutePoint {
  if (side === "top") return { x: point.x, y: point.y - ESCAPE };
  if (side === "bottom") return { x: point.x, y: point.y + ESCAPE };
  if (side === "left") return { x: point.x - ESCAPE, y: point.y };
  return { x: point.x + ESCAPE, y: point.y };
}

function inflate(box: RouteBox): RouteBox {
  return {
    x: box.x - OBSTACLE_GAP,
    y: box.y - OBSTACLE_GAP,
    w: box.w + OBSTACLE_GAP * 2,
    h: box.h + OBSTACLE_GAP * 2,
  };
}

function samePoint(a: RoutePoint, b: RoutePoint): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function simplify(points: RoutePoint[]): RoutePoint[] {
  const unique = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
  const out: RoutePoint[] = [];
  for (const point of unique) {
    const previous = out[out.length - 1];
    const before = out[out.length - 2];
    if (
      before &&
      previous &&
      ((Math.abs(before.x - previous.x) < EPSILON && Math.abs(previous.x - point.x) < EPSILON) ||
        (Math.abs(before.y - previous.y) < EPSILON && Math.abs(previous.y - point.y) < EPSILON))
    ) {
      out[out.length - 1] = point;
    } else {
      out.push(point);
    }
  }
  return out;
}

function segmentLength(a: RoutePoint, b: RoutePoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function segmentHitsBox(a: RoutePoint, b: RoutePoint, box: RouteBox): boolean {
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  if (Math.abs(a.x - b.x) < EPSILON) {
    if (a.x <= box.x + EPSILON || a.x >= right - EPSILON) return false;
    const low = Math.min(a.y, b.y);
    const high = Math.max(a.y, b.y);
    return high > box.y + EPSILON && low < bottom - EPSILON;
  }
  if (Math.abs(a.y - b.y) < EPSILON) {
    if (a.y <= box.y + EPSILON || a.y >= bottom - EPSILON) return false;
    const low = Math.min(a.x, b.x);
    const high = Math.max(a.x, b.x);
    return high > box.x + EPSILON && low < right - EPSILON;
  }
  return true;
}

interface Segment {
  a: RoutePoint;
  b: RoutePoint;
}

function segments(points: RoutePoint[]): Segment[] {
  return points.slice(1).map((point, index) => ({ a: points[index], b: point }));
}

function sharedLength(first: Segment, second: Segment): number {
  const firstVertical = Math.abs(first.a.x - first.b.x) < EPSILON;
  const secondVertical = Math.abs(second.a.x - second.b.x) < EPSILON;
  if (firstVertical !== secondVertical) return 0;
  if (firstVertical) {
    if (Math.abs(first.a.x - second.a.x) >= EPSILON) return 0;
    return Math.max(
      0,
      Math.min(Math.max(first.a.y, first.b.y), Math.max(second.a.y, second.b.y)) -
        Math.max(Math.min(first.a.y, first.b.y), Math.min(second.a.y, second.b.y))
    );
  }
  if (Math.abs(first.a.y - second.a.y) >= EPSILON) return 0;
  return Math.max(
    0,
    Math.min(Math.max(first.a.x, first.b.x), Math.max(second.a.x, second.b.x)) -
      Math.max(Math.min(first.a.x, first.b.x), Math.min(second.a.x, second.b.x))
  );
}

function crosses(first: Segment, second: Segment): boolean {
  const firstVertical = Math.abs(first.a.x - first.b.x) < EPSILON;
  const secondVertical = Math.abs(second.a.x - second.b.x) < EPSILON;
  if (firstVertical === secondVertical) return false;
  const vertical = firstVertical ? first : second;
  const horizontal = firstVertical ? second : first;
  const x = vertical.a.x;
  const y = horizontal.a.y;
  return (
    x > Math.min(horizontal.a.x, horizontal.b.x) + EPSILON &&
    x < Math.max(horizontal.a.x, horizontal.b.x) - EPSILON &&
    y > Math.min(vertical.a.y, vertical.b.y) + EPSILON &&
    y < Math.max(vertical.a.y, vertical.b.y) - EPSILON
  );
}

function midpoint(points: RoutePoint[]): RoutePoint {
  const total = segments(points).reduce((sum, segment) => sum + segmentLength(segment.a, segment.b), 0);
  let remaining = total / 2;
  for (const segment of segments(points)) {
    const length = segmentLength(segment.a, segment.b);
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      return {
        x: segment.a.x + (segment.b.x - segment.a.x) * ratio,
        y: segment.a.y + (segment.b.y - segment.a.y) * ratio,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

function laneValues(start: number, end: number, boundaries: number[]): number[] {
  const middle = (start + end) / 2;
  const values = [start, end, middle];
  for (let offset = LANE_STEP; offset <= LANE_STEP * 3; offset += LANE_STEP) {
    values.push(middle - offset, middle + offset);
  }
  values.push(...boundaries);
  return [...new Set(values.map((value) => Math.round(value * 10) / 10))];
}

function candidatesFor(
  start: RoutePoint,
  sourceEscape: RoutePoint,
  targetEscape: RoutePoint,
  end: RoutePoint,
  obstacles: RouteBox[]
): RoutePoint[][] {
  const xBoundaries = obstacles.flatMap((box) => [box.x, box.x + box.w]);
  const yBoundaries = obstacles.flatMap((box) => [box.y, box.y + box.h]);
  const candidates: RoutePoint[][] = [];
  const add = (middle: RoutePoint[]) => {
    candidates.push(simplify([start, sourceEscape, ...middle, targetEscape, end]));
  };

  if (
    Math.abs(sourceEscape.x - targetEscape.x) < EPSILON ||
    Math.abs(sourceEscape.y - targetEscape.y) < EPSILON
  ) {
    add([]);
  }
  add([{ x: targetEscape.x, y: sourceEscape.y }]);
  add([{ x: sourceEscape.x, y: targetEscape.y }]);

  for (const y of laneValues(sourceEscape.y, targetEscape.y, yBoundaries)) {
    add([
      { x: sourceEscape.x, y },
      { x: targetEscape.x, y },
    ]);
  }
  for (const x of laneValues(sourceEscape.x, targetEscape.x, xBoundaries)) {
    add([
      { x, y: sourceEscape.y },
      { x, y: targetEscape.y },
    ]);
  }

  const seen = new Set<string>();
  return candidates.filter((points) => {
    const key = points.map((point) => `${point.x},${point.y}`).join(";");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function routeScore(
  points: RoutePoint[],
  occupied: Segment[]
): number {
  const routeSegments = segments(points);
  let score = routeSegments.reduce(
    (sum, segment) => sum + segmentLength(segment.a, segment.b),
    Math.max(0, routeSegments.length - 1) * 18
  );

  for (let i = 0; i < routeSegments.length; i++) {
    const segment = routeSegments[i];
    for (const used of occupied) {
      score += sharedLength(segment, used) * 6;
      if (crosses(segment, used)) score += 600;
    }
  }
  return score;
}

function routeIsClear(
  points: RoutePoint[],
  request: EdgeRouteRequest,
  boxes: Map<string, RouteBox>
): boolean {
  const routeSegments = segments(points);
  for (let index = 0; index < routeSegments.length; index++) {
    const segment = routeSegments[index];
    for (const [nodeId, box] of boxes) {
      if (nodeId === request.sourceId && index === 0) continue;
      if (nodeId === request.targetId && index === routeSegments.length - 1) continue;
      if (segmentHitsBox(segment.a, segment.b, inflate(box))) return false;
    }
  }
  return true;
}

function nearbyBoxes(
  request: EdgeRouteRequest,
  boxes: Map<string, RouteBox>,
  margin = ROUTE_SEARCH_MARGIN
): Map<string, RouteBox> {
  const left = Math.min(request.source.x, request.target.x) - margin;
  const top = Math.min(request.source.y, request.target.y) - margin;
  const right =
    Math.max(
      request.source.x + request.source.w,
      request.target.x + request.target.w
    ) + margin;
  const bottom =
    Math.max(
      request.source.y + request.source.h,
      request.target.y + request.target.h
    ) + margin;
  return new Map(
    [...boxes].filter(([, box]) => {
      return (
        box.x + box.w >= left &&
        box.x <= right &&
        box.y + box.h >= top &&
        box.y <= bottom
      );
    })
  );
}

function pointInsideBox(point: RoutePoint, box: RouteBox): boolean {
  return (
    point.x > box.x + EPSILON &&
    point.x < box.x + box.w - EPSILON &&
    point.y > box.y + EPSILON &&
    point.y < box.y + box.h - EPSILON
  );
}

/** A compressed rectilinear grid is the correctness fallback for layouts
 * that need more than one detour. Its rows and columns come only from card
 * boundaries, so it can walk around staggered obstacles without scanning the
 * canvas pixel by pixel. */
function gridRoute(
  start: RoutePoint,
  end: RoutePoint,
  boxes: Map<string, RouteBox>,
  occupied: Segment[]
): RoutePoint[] | null {
  const obstacles = [...boxes.values()].map(inflate);
  const unique = (values: number[]) =>
    [...new Set(values.map((value) => Math.round(value * 10) / 10))].sort(
      (a, b) => a - b
    );
  const xs = unique([
    start.x,
    end.x,
    ...obstacles.flatMap((box) => [box.x, box.x + box.w]),
  ]);
  const ys = unique([
    start.y,
    end.y,
    ...obstacles.flatMap((box) => [box.y, box.y + box.h]),
  ]);
  const xIndex = new Map(xs.map((value, index) => [value, index]));
  const yIndex = new Map(ys.map((value, index) => [value, index]));
  const startX = xIndex.get(Math.round(start.x * 10) / 10);
  const startY = yIndex.get(Math.round(start.y * 10) / 10);
  const endX = xIndex.get(Math.round(end.x * 10) / 10);
  const endY = yIndex.get(Math.round(end.y * 10) / 10);
  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
    return null;
  }

  type Direction = "none" | "horizontal" | "vertical";
  type State = { x: number; y: number; direction: Direction };
  type QueueItem = State & { cost: number };
  const keyOf = ({ x, y, direction }: State) => `${x}:${y}:${direction}`;
  const queue: QueueItem[] = [];
  const push = (item: QueueItem) => {
    queue.push(item);
    let index = queue.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (queue[parent].cost <= item.cost) break;
      queue[index] = queue[parent];
      index = parent;
    }
    queue[index] = item;
  };
  const pop = (): QueueItem | undefined => {
    const first = queue[0];
    const last = queue.pop();
    if (!first || !last || queue.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= queue.length) break;
      const child = right < queue.length && queue[right].cost < queue[left].cost ? right : left;
      if (queue[child].cost >= last.cost) break;
      queue[index] = queue[child];
      index = child;
    }
    queue[index] = last;
    return first;
  };

  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const states = new Map<string, State>();
  const initial: State = { x: startX, y: startY, direction: "none" };
  distances.set(keyOf(initial), 0);
  states.set(keyOf(initial), initial);
  push({ ...initial, cost: 0 });
  let finishKey: string | null = null;

  while (queue.length > 0) {
    const current = pop()!;
    const currentKey = keyOf(current);
    if (current.cost !== distances.get(currentKey)) continue;
    if (current.x === endX && current.y === endY) {
      finishKey = currentKey;
      break;
    }
    const neighbours = [
      { x: current.x - 1, y: current.y, direction: "horizontal" as const },
      { x: current.x + 1, y: current.y, direction: "horizontal" as const },
      { x: current.x, y: current.y - 1, direction: "vertical" as const },
      { x: current.x, y: current.y + 1, direction: "vertical" as const },
    ];
    const from = { x: xs[current.x], y: ys[current.y] };
    for (const neighbour of neighbours) {
      if (
        neighbour.x < 0 ||
        neighbour.x >= xs.length ||
        neighbour.y < 0 ||
        neighbour.y >= ys.length
      ) {
        continue;
      }
      const to = { x: xs[neighbour.x], y: ys[neighbour.y] };
      if (obstacles.some((box) => pointInsideBox(to, box))) continue;
      if (obstacles.some((box) => segmentHitsBox(from, to, box))) continue;
      const segment = { a: from, b: to };
      let step = segmentLength(from, to);
      if (current.direction !== "none" && current.direction !== neighbour.direction) {
        step += 18;
      }
      for (const used of occupied) {
        step += sharedLength(segment, used) * 6;
        if (crosses(segment, used)) step += 600;
      }
      const next: State = neighbour;
      const nextKey = keyOf(next);
      const cost = current.cost + step;
      if (cost >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(nextKey, cost);
      previous.set(nextKey, currentKey);
      states.set(nextKey, next);
      push({ ...next, cost });
    }
  }

  if (!finishKey) return null;
  const reversed: RoutePoint[] = [];
  for (let key: string | undefined = finishKey; key; key = previous.get(key)) {
    const state = states.get(key);
    if (!state) break;
    reversed.push({ x: xs[state.x], y: ys[state.y] });
  }
  return simplify(reversed.reverse());
}

/** Route a set together so links may share the short stem at a real card
 * handle, then choose separate clear lanes after they leave it. */
export function routeOrthogonalEdges(
  requests: EdgeRouteRequest[],
  boxes: Map<string, RouteBox>
): Map<string, EdgeRouteGeometry> {
  const ordered = [...requests].sort((a, b) => {
    const source = a.sourceId.localeCompare(b.sourceId);
    if (source) return source;
    const side = a.sourceSide.localeCompare(b.sourceSide);
    if (side) return side;
    const aTarget = center(a.target);
    const bTarget = center(b.target);
    const axis =
      a.sourceSide === "left" || a.sourceSide === "right"
        ? aTarget.y - bTarget.y
        : aTarget.x - bTarget.x;
    return axis || a.id.localeCompare(b.id);
  });
  const occupied: Segment[] = [];
  const routed = new Map<string, EdgeRouteGeometry>();

  for (const request of ordered) {
    // These are the same four mid-edge anchors shown on the card and used by
    // a manual drag. Routing may share the short escape stem, but it never
    // invents a hidden attachment point elsewhere on the card.
    const start = centrePort(request.source, request.sourceSide);
    const end = centrePort(request.target, request.targetSide);
    const sourceOut = escapePoint(start, request.sourceSide);
    const targetOut = escapePoint(end, request.targetSide);
    const localBoxes = nearbyBoxes(request, boxes);
    const obstacles = [...localBoxes.values()].map(inflate);
    const candidates = candidatesFor(start, sourceOut, targetOut, end, obstacles);
    const clearCandidates = candidates.filter((candidate) =>
      routeIsClear(candidate, request, boxes)
    );
    let best = clearCandidates[0] ?? null;
    let bestScore = best ? routeScore(best, occupied) : Number.POSITIVE_INFINITY;
    for (const candidate of clearCandidates.slice(1)) {
      const score = routeScore(candidate, occupied);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) {
      const middle = gridRoute(sourceOut, targetOut, boxes, occupied);
      if (middle) {
        const fallback = simplify([start, ...middle, end]);
        if (routeIsClear(fallback, request, boxes)) best = fallback;
      }
    }
    // Overlapping endpoint cards can make a collision-free route
    // geometrically impossible. Preserve a visible connection in that one
    // case; ordinary non-overlapping layouts always take a clear path above.
    if (!best) best = candidates[0];
    const points = simplify(best);
    occupied.push(...segments(points));
    routed.set(request.id, { points, label: midpoint(points) });
  }

  return routed;
}

/** Convert a rectilinear route into one SVG path with restrained rounded
 * corners. The route remains crisp, but no longer looks like plumbing. */
export function roundedOrthogonalPath(points: RoutePoint[], radius = 10): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const beforeLength = segmentLength(previous, corner);
    const afterLength = segmentLength(corner, next);
    const bend = Math.min(radius, beforeLength / 2, afterLength / 2);
    const before = {
      x: corner.x + Math.sign(previous.x - corner.x) * bend,
      y: corner.y + Math.sign(previous.y - corner.y) * bend,
    };
    const after = {
      x: corner.x + Math.sign(next.x - corner.x) * bend,
      y: corner.y + Math.sign(next.y - corner.y) * bend,
    };
    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  const end = points[points.length - 1];
  return `${path} L ${end.x} ${end.y}`;
}
