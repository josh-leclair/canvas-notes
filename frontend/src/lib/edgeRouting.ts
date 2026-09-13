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

const PORT_PADDING = 26;
const PORT_GAP = 34;
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

function portRange(box: RouteBox, side: RouteSide): [number, number] {
  const vertical = side === "left" || side === "right";
  const start = vertical ? box.y : box.x;
  const length = vertical ? box.h : box.w;
  const padding = Math.min(PORT_PADDING, Math.max(8, length * 0.22));
  return [start + padding, start + length - padding];
}

function portPoint(box: RouteBox, side: RouteSide, axis: number): RoutePoint {
  if (side === "top") return { x: axis, y: box.y };
  if (side === "bottom") return { x: axis, y: box.y + box.h };
  if (side === "left") return { x: box.x, y: axis };
  return { x: box.x + box.w, y: axis };
}

function desiredPortAxis(box: RouteBox, other: RouteBox, side: RouteSide): number {
  const vertical = side === "left" || side === "right";
  const ownStart = vertical ? box.y : box.x;
  const ownEnd = ownStart + (vertical ? box.h : box.w);
  const otherStart = vertical ? other.y : other.x;
  const otherEnd = otherStart + (vertical ? other.h : other.w);
  const overlapStart = Math.max(ownStart, otherStart);
  const overlapEnd = Math.min(ownEnd, otherEnd);

  // When the rectangles overlap along this edge, aim through the centre of
  // that overlap. This is especially important for a heading spanning all of
  // its children: both ends then line up above the child instead of every
  // child reaching back toward the heading's distant centre.
  if (overlapStart <= overlapEnd) return (overlapStart + overlapEnd) / 2;
  return vertical ? center(other).y : center(other).x;
}

function distribute(values: number[], min: number, max: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1 || max <= min) {
    return values.map((value) => Math.max(min, Math.min(max, value)));
  }
  const gap = Math.min(PORT_GAP, (max - min) / (values.length - 1));
  const out = values.map((value) => Math.max(min, Math.min(max, value)));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out[out.length - 1] > max) {
    out[out.length - 1] = max;
    for (let i = out.length - 2; i >= 0; i--) {
      out[i] = Math.min(out[i], out[i + 1] - gap);
    }
  }
  if (out[0] < min) {
    out[0] = min;
    for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + gap;
  }
  return out;
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
  request: EdgeRouteRequest,
  boxes: Map<string, RouteBox>,
  occupied: Segment[]
): number {
  const routeSegments = segments(points);
  let score = routeSegments.reduce(
    (sum, segment) => sum + segmentLength(segment.a, segment.b),
    Math.max(0, routeSegments.length - 1) * 18
  );

  for (let i = 0; i < routeSegments.length; i++) {
    const segment = routeSegments[i];
    for (const [nodeId, rawBox] of boxes) {
      if (nodeId === request.sourceId && i === 0) continue;
      if (nodeId === request.targetId && i === routeSegments.length - 1) continue;
      if (segmentHitsBox(segment.a, segment.b, inflate(rawBox))) score += 100_000;
    }
    for (const used of occupied) {
      score += sharedLength(segment, used) * 6;
      if (crosses(segment, used)) score += 600;
    }
  }
  return score;
}

function nearbyBoxes(
  request: EdgeRouteRequest,
  boxes: Map<string, RouteBox>
): Map<string, RouteBox> {
  const left = Math.min(request.source.x, request.target.x) - ROUTE_SEARCH_MARGIN;
  const top = Math.min(request.source.y, request.target.y) - ROUTE_SEARCH_MARGIN;
  const right =
    Math.max(
      request.source.x + request.source.w,
      request.target.x + request.target.w
    ) + ROUTE_SEARCH_MARGIN;
  const bottom =
    Math.max(
      request.source.y + request.source.h,
      request.target.y + request.target.h
    ) + ROUTE_SEARCH_MARGIN;
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

/** Route a set together so shared card edges can fan their ports out and each
 * successive line can avoid lanes already occupied by an earlier one. */
export function routeOrthogonalEdges(
  requests: EdgeRouteRequest[],
  boxes: Map<string, RouteBox>
): Map<string, EdgeRouteGeometry> {
  type Endpoint = {
    request: EdgeRouteRequest;
    role: "source" | "target";
    nodeId: string;
    side: RouteSide;
    box: RouteBox;
    other: RouteBox;
  };
  const endpointGroups = new Map<string, Endpoint[]>();
  for (const request of requests) {
    const endpoints: Endpoint[] = [
      {
        request,
        role: "source",
        nodeId: request.sourceId,
        side: request.sourceSide,
        box: request.source,
        other: request.target,
      },
      {
        request,
        role: "target",
        nodeId: request.targetId,
        side: request.targetSide,
        box: request.target,
        other: request.source,
      },
    ];
    for (const endpoint of endpoints) {
      const key = `${endpoint.nodeId}:${endpoint.side}`;
      (endpointGroups.get(key) ?? endpointGroups.set(key, []).get(key)!).push(endpoint);
    }
  }

  const ports = new Map<string, RoutePoint>();
  for (const endpoints of endpointGroups.values()) {
    endpoints.sort((a, b) => {
      const axis =
        desiredPortAxis(a.box, a.other, a.side) -
        desiredPortAxis(b.box, b.other, b.side);
      return axis || a.request.id.localeCompare(b.request.id) || a.role.localeCompare(b.role);
    });
    const [min, max] = portRange(endpoints[0].box, endpoints[0].side);
    const desired = endpoints.map((endpoint) =>
      desiredPortAxis(endpoint.box, endpoint.other, endpoint.side)
    );
    const axes = distribute(desired, min, max);
    endpoints.forEach((endpoint, index) => {
      ports.set(`${endpoint.request.id}:${endpoint.role}`, portPoint(endpoint.box, endpoint.side, axes[index]));
    });
  }

  const ordered = [...requests].sort((a, b) => {
    const source = a.sourceId.localeCompare(b.sourceId);
    if (source) return source;
    const side = a.sourceSide.localeCompare(b.sourceSide);
    if (side) return side;
    const axis =
      desiredPortAxis(a.source, a.target, a.sourceSide) -
      desiredPortAxis(b.source, b.target, b.sourceSide);
    return axis || a.id.localeCompare(b.id);
  });
  const occupied: Segment[] = [];
  const routed = new Map<string, EdgeRouteGeometry>();

  for (const request of ordered) {
    const start = ports.get(`${request.id}:source`) ?? center(request.source);
    const end = ports.get(`${request.id}:target`) ?? center(request.target);
    const sourceOut = escapePoint(start, request.sourceSide);
    const targetOut = escapePoint(end, request.targetSide);
    const localBoxes = nearbyBoxes(request, boxes);
    const obstacles = [...localBoxes.values()].map(inflate);
    const candidates = candidatesFor(start, sourceOut, targetOut, end, obstacles);
    let best = candidates[0];
    let bestScore = routeScore(best, request, localBoxes, occupied);
    for (const candidate of candidates.slice(1)) {
      const score = routeScore(candidate, request, localBoxes, occupied);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
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
