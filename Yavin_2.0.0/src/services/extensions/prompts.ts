/**
 * Extensions' prompts in the window (EXT-29): VS Code's `showQuickPick` and `showInputBox`,
 * shown one at a time in Yavin's own style (`components/extensions/ExtensionPrompt.tsx`).
 *
 * - **One at a time, in order.** Prompts from different extensions wait their turn: one
 *   extension's prompt never closes another's (the host makes an extension's new prompt
 *   replace its own earlier one, as VS Code does). At most `limit` wait; past that a prompt is
 *   answered null at once, as if cancelled.
 * - **Every prompt is answered.** By the user, or null: when it is cancelled (its signal -- the
 *   extension asked, stopped or crashed, or its host ended), or when the window closes
 *   (`cancelAll`). Nothing is left waiting.
 */
import type { InputBoxRequest, QuickPickRequest } from "./window.ts";

export type PromptRequest =
  ({ kind: "quickPick" } & QuickPickRequest) | ({ kind: "inputBox" } & InputBoxRequest);

export type PromptAnswer = number | number[] | string | null;

export interface ShownPrompt {
  /** Unique per prompt: the view is keyed by it. */
  id: number;
  request: PromptRequest;
}

interface Waiting extends ShownPrompt {
  resolve(answer: PromptAnswer): void;
  stop(): void;
}

export function createPromptService(limit = 8) {
  let queue: Waiting[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  let snapshot: ShownPrompt | null = null;
  const changed = () => {
    const head = queue[0] ?? null;
    snapshot = head ? { id: head.id, request: head.request } : null;
    for (const listener of [...listeners]) listener();
  };
  const settle = (id: number, answer: PromptAnswer) => {
    const index = queue.findIndex((one) => one.id === id);
    if (index === -1) return;
    const [one] = queue.splice(index, 1);
    one.stop();
    one.resolve(answer);
    if (index === 0) changed();
  };
  const show = (request: PromptRequest, signal: AbortSignal) =>
    new Promise<PromptAnswer>((resolve) => {
      if (signal.aborted || queue.length >= limit) {
        resolve(null);
        return;
      }
      const id = nextId++;
      const onAbort = () => settle(id, null);
      signal.addEventListener("abort", onAbort, { once: true });
      queue = [
        ...queue,
        { id, request, resolve, stop: () => signal.removeEventListener("abort", onAbort) },
      ];
      if (queue.length === 1) changed();
    });
  return {
    quickPick: (request: QuickPickRequest, signal: AbortSignal) =>
      show({ kind: "quickPick", ...request }, signal) as Promise<number | number[] | null>,
    inputBox: (request: InputBoxRequest, signal: AbortSignal) =>
      show({ kind: "inputBox", ...request }, signal) as Promise<string | null>,
    /** The prompt shown now (the first waiting), or null. */
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The user answered the prompt shown (a late answer to one already gone does nothing). */
    answer: (id: number, answer: PromptAnswer) => settle(id, answer),
    /** The window closes: every prompt, shown or waiting, is answered null. */
    cancelAll() {
      const all = queue;
      queue = [];
      for (const one of all) {
        one.stop();
        one.resolve(null);
      }
      if (all.length) changed();
    },
  };
}

export type PromptService = ReturnType<typeof createPromptService>;
