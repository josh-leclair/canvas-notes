export const INBOX_TOUCH_DROP_EVENT = "canvas-notes:inbox-touch-drop";

export interface InboxTouchDropDetail {
  cardId: string;
  clientX: number;
  clientY: number;
}
