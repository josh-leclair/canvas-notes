import { create } from "zustand";

/** In-app confirmation and prompt.
 *
 * Native `window.confirm` / `window.prompt` are suppressed outright in
 * sandboxed and embedded browsing contexts: they return false or null with no
 * dialog and no console output, which silently turns every destructive action
 * into a no-op. They also ignore the app's theme and block the main thread.
 * Everything goes through here instead.
 */

export interface ConfirmOptions {
  title: string;
  body?: string;
  /** Extra lines, e.g. the other canvases a card appears on. */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export type DialogRequest =
  | ({ kind: "confirm"; resolve: (value: boolean) => void } & ConfirmOptions)
  | ({ kind: "prompt"; resolve: (value: string | null) => void } & PromptOptions);

interface DialogState {
  request: DialogRequest | null;
  close: (value: boolean | string | null) => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  request: null,
  close: (value) => {
    const request = get().request;
    set({ request: null });
    if (!request) return;
    if (request.kind === "confirm") {
      request.resolve(value === true);
    } else {
      request.resolve(typeof value === "string" ? value : null);
    }
  },
}));

function open(request: DialogRequest) {
  // A second dialog cancels the first rather than orphaning its promise.
  const existing = useDialogStore.getState().request;
  if (existing) {
    if (existing.kind === "confirm") existing.resolve(false);
    else existing.resolve(null);
  }
  useDialogStore.setState({ request });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => open({ kind: "confirm", ...options, resolve }));
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ kind: "prompt", ...options, resolve }));
}
