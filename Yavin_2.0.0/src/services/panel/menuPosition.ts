/** Roughly one context-menu row, used to keep a menu on screen without measuring it. */
const MENU_ROW_HEIGHT = 24;
const MENU_WIDTH = 170;
const MENU_EDGE_GAP = 8;

/**
 * Where a context menu opened at `at` should actually be drawn so all of it stays within the
 * window.
 *
 * The bottom panel sits at the bottom of the screen, so a menu placed at the pointer runs off
 * the edge and its last entries become unclickable -- which is what happened the moment the
 * terminal's menu gained one more item. Pure, so it is testable without a DOM.
 */
export function clampToViewport(
  at: { x: number; y: number },
  itemCount: number,
  viewport: { width: number; height: number } = {
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  },
): { left: number; top: number } {
  const height = itemCount * MENU_ROW_HEIGHT + MENU_EDGE_GAP;
  const maxTop = Math.max(MENU_EDGE_GAP, viewport.height - height - MENU_EDGE_GAP);
  const maxLeft = Math.max(MENU_EDGE_GAP, viewport.width - MENU_WIDTH - MENU_EDGE_GAP);
  return { left: Math.min(at.x, maxLeft), top: Math.min(at.y, maxTop) };
}
