/**
 * Whether the user has turned to something else since a focus was asked for (EXT-24).
 *
 * The code editor is loaded lazily: the first document opened in a session is bound -- and the
 * editor focused -- only once the editing engine has loaded, which can be seconds after the
 * click that opened it. Focus taken that late can land on top of what the user has done since:
 * a file clicked, then others Ctrl+clicked, then Delete pressed, would type Delete into the
 * editor instead of deleting the files. A late focus therefore yields when the user has pressed
 * a pointer or a key somewhere else since the request -- their own input, not focus moving by
 * itself: a dialog closing and handing focus back (New File, Quick Open) is no such input, and
 * then the editor still takes focus, as it would have at once.
 *
 * Loaded eagerly (by the editor area), so it has seen every input since the window began.
 */

interface Input {
  at: number;
  target: EventTarget | null;
}

const inputs: Input[] = [];
const HISTORY = 32;
const now = () => performance.now();

if (typeof window !== "undefined")
  for (const type of ["pointerdown", "keydown"])
    window.addEventListener(
      type,
      (event) => {
        inputs.push({ at: now(), target: event.target });
        if (inputs.length > HISTORY) inputs.shift();
      },
      true,
    );

/** A request for focus: when it was made. */
export interface FocusRequest {
  at: number;
}

/** Notes a request for focus now. */
export function noteFocusRequest(): FocusRequest {
  return { at: now() };
}

/**
 * Whether, since `request`, the user pressed a pointer or a key on something outside `within`
 * (the one asking) -- and focus is not in `within` now.
 */
export function focusMovedSince(request: FocusRequest, within: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (within && active && within.contains(active)) return false;
  return inputs.some(
    (input) =>
      input.at > request.at &&
      input.target instanceof Node &&
      input.target !== document.body &&
      !within?.contains(input.target),
  );
}
