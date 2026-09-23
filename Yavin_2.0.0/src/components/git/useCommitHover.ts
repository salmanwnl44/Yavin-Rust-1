import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, MouseEvent } from "react";
import type { RawCommit } from "../../services/git/parsers/log";
import { CARD_WIDTH, HOVER_DELAY } from "./CommitHoverCard";

/** How long the card survives the pointer leaving, so it can be moved onto. */
const LEAVE_GRACE = 160;

/**
 * Hover intent for the commit graphs.
 *
 * Both graphs show the same card and must feel the same, so the timing lives here rather
 * than twice. Three things this has to get right: not firing while the pointer is merely
 * crossing the list, not vanishing while someone is moving the pointer onto the card to
 * click "Open on GitHub", and opening on keyboard focus too -- the card holds the only copy
 * button and the only link to the hosting site, so it cannot be mouse-only.
 */
export function useCommitHover(container?: { current: HTMLElement | null }) {
  const [hovered, setHovered] = useState<{
    commit: RawCommit;
    anchor: { x: number; y: number };
  } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overCard = useRef(false);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const openFrom = useCallback(
    (commit: RawCommit, element: HTMLElement, delay: number) => {
      if (openTimer.current) clearTimeout(openTimer.current);
      const row = element.getBoundingClientRect();
      // Beside the list, not on top of it: a card over the rows hides the commits either side
      // of the one being read, which is exactly the context that makes it worth reading.
      // Preferred to the right of the panel; to its left when there is no room there.
      const panel = container?.current?.getBoundingClientRect();
      const gap = 8;
      const room = typeof window === "undefined" ? 1024 : window.innerWidth;
      const x = !panel
        ? row.right + gap
        : panel.right + gap + CARD_WIDTH <= room
          ? panel.right + gap
          : Math.max(gap, panel.left - gap - CARD_WIDTH);
      // Level with the row it describes, which is what ties the two together.
      const anchor = { x, y: Math.max(gap, row.top - 4) };
      openTimer.current = setTimeout(() => setHovered({ commit, anchor }), delay);
    },
    [container],
  );

  const scheduleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!overCard.current) setHovered(null);
    }, LEAVE_GRACE);
  }, []);

  const rowHandlers = useCallback(
    (commit: RawCommit) => ({
      onMouseEnter: (event: MouseEvent<HTMLElement>) =>
        openFrom(commit, event.currentTarget, HOVER_DELAY),
      onMouseLeave: scheduleClose,
      // No delay on focus: arriving by keyboard is already deliberate.
      onFocus: (event: FocusEvent<HTMLElement>) => openFrom(commit, event.currentTarget, 0),
      onBlur: scheduleClose,
    }),
    [openFrom, scheduleClose],
  );

  const cardHandlers = {
    onPointerEnter: () => {
      overCard.current = true;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    onPointerLeave: () => {
      overCard.current = false;
      scheduleClose();
    },
    onClose: () => {
      overCard.current = false;
      clearTimers();
      setHovered(null);
    },
  };

  return { hovered, rowHandlers, cardHandlers };
}
