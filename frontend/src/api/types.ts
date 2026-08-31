export interface User {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

export type CardType =
  | "text"
  | "link"
  | "youtube"
  | "audio"
  | "image"
  | "board"
  | "column"
  | "file"
  | "checklist"
  | "table"
  | "document"
  | "portal";

export interface BoardRef {
  canvas_id: string;
  name: string;
  card_count: number;
  has_cover: boolean;
  role: Role;
}

export interface Card {
  id: string;
  type: CardType;
  title: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  inbox_canvas_id: string | null;
  /** Present on board cards: the canvas this one opens. */
  board?: BoardRef | null;
}

/** Stamped on cards a model produced, so they stay identifiable after being
 * placed and can be discarded a whole batch at a time. */
export interface GeneratedBy {
  model: string;
  at: string;
  source_card_id: string;
  batch_id: string;
  /** Set on the one card the rest of a split are meant to hang off. */
  hero?: boolean;
}

export interface BatchStatus {
  batch_id: string;
  status: "queued" | "running" | "done" | "error";
  cards: Card[];
  error: string | null;
}

export interface CompositionStatus {
  batch_id: string;
  status: "queued" | "running" | "done" | "error";
  card: Card | null;
  placement: Placement | null;
  error: string | null;
}

export interface Placement {
  id: string;
  canvas_id: string;
  card_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  is_hub: boolean;
  parent_id: string | null;
  sort: number;
  updated_at: string;
}

export interface PlacementWithCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  is_hub: boolean;
  parent_id: string | null;
  sort: number;
  card: Card;
}

export type Role = "owner" | "editor" | "viewer";
export type CanvasAppearance = "studio" | "pantry" | "night_garden";

export interface CanvasSummary {
  id: string;
  name: string;
  is_infinite: boolean;
  width: number;
  height: number;
  appearance?: CanvasAppearance;
  card_count: number;
  created_at: string;
  updated_at: string;
  role: Role;
  has_cover: boolean;
  /** Some board card points at this canvas, so it lives inside another. */
  is_nested: boolean;
}

export interface CanvasDetail {
  id: string;
  name: string;
  is_infinite: boolean;
  width: number;
  height: number;
  appearance?: CanvasAppearance;
  role: Role;
  has_cover: boolean;
  placements: PlacementWithCard[];
  zones: Zone[];
  /** Links with both endpoints on this canvas. */
  links: Link[];
}

export interface Zone {
  id: string;
  canvas_id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface PublicLensSummary {
  id: string;
  canvas_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  revision: number;
  published_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
  card_count: number;
  view_mode: PublicLensViewMode;
}

export type PublicLensViewMode = "canvas" | "presentation";

export interface PublicLensPlacement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  is_hub: boolean;
  parent_id: string | null;
  sort: number;
  card: Pick<Card, "id" | "type" | "title" | "body" | "payload">;
}

export interface PublicLensLink {
  id: string;
  source_card_id: string;
  target_card_id: string;
  link_type: string | null;
  note: string | null;
}

export interface PublicLensView {
  slug: string;
  title: string;
  description: string | null;
  revision: number;
  published_at: string;
  snapshot: {
    version: number;
    view_mode?: PublicLensViewMode;
    sequence?: string[];
    appearance?: CanvasAppearance;
    text_size?: number;
    placements: PublicLensPlacement[];
    links: PublicLensLink[];
    asset_ids: string[];
  };
}

export interface CanvasMember {
  user_id: string;
  email: string;
  display_name: string;
  role: "viewer" | "editor";
}

export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiTokenCreated extends ApiToken {
  token: string;
}

export interface PairingCode {
  id: string;
  code: string;
  expires_at: string;
}

export interface BotIdentity {
  id: string;
  platform: string;
  platform_user_id: string;
  created_at: string;
}

export interface SearchHit {
  card: Card;
  placements: CardPlacementInfo[];
  score: number;
  source: "text" | "semantic";
}

/** A link whose note matched. Both ends come back because a note on its own
 *  says nothing — it is only meaningful once you can see what it joins. */
export interface LinkHit {
  link: Link;
  source: Card | null;
  target: Card | null;
  score: number;
  /** Where each end can be reached. The note that matched lives on the link
   *  rather than on either card, so neither end necessarily turns up among
   *  the card hits — without these there would be nowhere to send you. */
  source_placements: CardPlacementInfo[];
  target_placements: CardPlacementInfo[];
}

export interface SearchOut {
  hits: SearchHit[];
  link_hits: LinkHit[];
  modes_available: string[];
}

export interface Suggestion {
  card: Card;
  distance: number;
}

export interface CanvasSuggestion {
  canvas_id: string;
  canvas_name: string;
  score: number;
}

export interface CardPlacementInfo {
  id: string;
  canvas_id: string;
  canvas_name: string;
  x: number;
  y: number;
}

export interface PortalConfig {
  scope: "workspace" | "canvas";
  canvas_id?: string;
  query: string;
  card_type: CardType | "any";
  open_tasks: boolean;
  timeframe: "any" | "today";
  timezone_offset_minutes: number;
  limit: number;
}

export interface PortalItem {
  card: Card;
  placements: CardPlacementInfo[];
}

export interface PortalOut {
  items: PortalItem[];
  total: number;
  source_name: string;
}

export interface FocusItem {
  card: Card;
  placements: CardPlacementInfo[];
}

export interface DailyCardResult {
  card: Card | null;
  placement: Placement | null;
}

export const LINK_TYPES = [
  "touched",
  "references",
  "supports",
  "contradicts",
  "source_for",
  "follows_from",
  "related",
] as const;

export type LinkType = (typeof LINK_TYPES)[number];

export interface Snapshot {
  title?: string | null;
  url?: string | null;
  excerpt?: string | null;
}

export interface Link {
  id: string;
  source_card_id: string | null;
  target_card_id: string | null;
  link_type: LinkType | null;
  note: string | null;
  created_on_canvas_id: string | null;
  source_snapshot: Snapshot;
  target_snapshot: Snapshot;
  created_at: string;
  updated_at: string;
}

export interface RevealLink extends Link {
  hop: number;
}

export interface RevealCardEntry {
  card: Card;
  placement: Placement | null;
  home_canvas_id: string | null;
  home_canvas_name: string | null;
}

export interface RevealOut {
  root_card_id: string;
  links: RevealLink[];
  cards: Record<string, RevealCardEntry>;
}

export interface Invite {
  id: string;
  code: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
}
