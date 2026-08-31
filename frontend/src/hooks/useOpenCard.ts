import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { CardPlacementInfo } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";

export function useOpenCard() {
  const navigate = useNavigate();

  return async (cardId: string) => {
    const state = useCanvasStore.getState();
    const here = state.nodes.find((node) => node.data.card.id === cardId);
    if (here && state.canvasId) {
      // Let the pointer event that activated the reference finish before
      // asking xyflow to change selection. Otherwise its node-click handling
      // can restore the source card immediately after we select the target.
      window.requestAnimationFrame(() => {
        useCanvasStore.getState().focusCards([cardId]);
      });
      return;
    }
    try {
      const placements = await api.get<CardPlacementInfo[]>(
        `/api/cards/${cardId}/placements`
      );
      const home = placements[0];
      if (home) {
        navigate(`/c/${home.canvas_id}?card=${cardId}`);
      } else {
        state.setInboxOpen(true);
        state.showToast("That referenced card is currently in your inbox.");
      }
    } catch {
      state.showToast("That referenced card is no longer available.");
    }
  };
}
