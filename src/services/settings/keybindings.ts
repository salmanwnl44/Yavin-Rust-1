/**
 * User keyboard-shortcut overrides (IDE-03 / WS20): the one store of the shortcuts a user has
 * reassigned, kept across restarts beside the other preferences. It is **not** a second command
 * registry -- it owns no commands and runs nothing. It maps a command id (an existing one, core
 * or extension) to the key the user wants for it, or to `null` to mean "no key at all" (the
 * command's default is removed). The command registry reads these overrides and resolves each
 * command's effective shortcut (`commandRegistry.setKeybindings`); the window's one keyboard
 * handler, the menus and the palette then show and dispatch the effective keys with no further
 * change.
 *
 * ```text
 *  override(id):  undefined  -> no override; the command keeps its default shortcut
 *                 "Mod+K"    -> the user bound this command to Mod+K
 *                 null       -> the user removed the command's key (unbound)
 * ```
 *
 * - **Preferences only, user scope.** A keybinding is the person's, the same in every workspace,
 *   like `editor.zoom`; there is no per-workspace keymap. (The native keymap enforcement surface
 *   -- `ide-config/keymap.rs` -- stays the runtime owner; this store only records the preference.)
 * - **Never trusted.** The stored record is validated on load: a binding whose key is not a valid
 *   shortcut, or whose command id is not a string, is dropped and reported once; an override for a
 *   command this build does not know is kept untouched (an extension's command may return). A
 *   record that cannot be read at all is copied to `<key>.corrupt` before anything is written over
 *   it; one written by a newer Yavin is not read and never written over -- the same rules the
 *   settings registry uses.
 * - **Safe by construction.** `isValidShortcut` refuses a key that would hijack ordinary typing (a
 *   bare printable key with no Mod/Alt) and a `Shift`+digit the matcher cannot round-trip, so a
 *   stored or assigned binding can never silently shadow plain editing.
 */

/** The key a shortcut matcher understands, without a leading modifier. */
const NAMED_KEYS = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  "delete",
  "insert",
  "backspace",
  "enter",
]);

/** Punctuation a shortcut may use; `matchesShortcut` matches these by physical key position. */
const PUNCTUATION = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"]);

/** `Digit1`-style code → its character, and `KeyA`-style → its letter, for building from an event. */
const CODE_PUNCTUATION: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const isFunctionKey = (key: string) => /^f([1-9]|1[0-9]|2[0-4])$/.test(key);
const isLetter = (key: string) => /^[a-z]$/.test(key);
const isDigit = (key: string) => /^[0-9]$/.test(key);

const isValidKey = (key: string) =>
  isLetter(key) ||
  isDigit(key) ||
  isFunctionKey(key) ||
  PUNCTUATION.has(key) ||
  NAMED_KEYS.has(key);

/**
 * Whether `shortcut` is one Yavin can bind and later match. A shortcut is modifiers (`Mod`,
 * `Alt`, `Shift`, in any order, each at most once) joined by `+` to one key. A key that is not a
 * function key must carry `Mod` or `Alt`, so a binding can never fire on ordinary typing; a
 * `Shift`+digit is refused because the matcher sees the shifted character, not the digit.
 */
export function isValidShortcut(shortcut: string): boolean {
  if (typeof shortcut !== "string" || shortcut.length === 0) return false;
  const parts = shortcut.split("+");
  if (parts.length < 1) return false;
  const key = (parts.pop() ?? "").toLowerCase();
  if (!isValidKey(key)) return false;
  const mods = parts.map((part) => part.toLowerCase());
  if (mods.length > 3) return false;
  const seen = new Set<string>();
  for (const mod of mods) {
    if (mod !== "mod" && mod !== "alt" && mod !== "shift") return false;
    if (seen.has(mod)) return false;
    seen.add(mod);
  }
  const hasModOrAlt = seen.has("mod") || seen.has("alt");
  // A printable or editing key with no Mod/Alt would capture plain typing.
  if (!isFunctionKey(key) && !hasModOrAlt) return false;
  // Shift+digit is the shifted character to the matcher ("!" not "1"); it cannot round-trip.
  if (isDigit(key) && seen.has("shift")) return false;
  return true;
}

/** The canonical spelling of `shortcut`: modifiers as `Mod`/`Alt`/`Shift` in a fixed order, then
 * the key. Two shortcuts with the same meaning produce the same string, so stored and assigned
 * keys compare and de-duplicate cleanly. Returns `undefined` for an invalid shortcut. */
export function canonicalShortcut(shortcut: string): string | undefined {
  if (!isValidShortcut(shortcut)) return undefined;
  const parts = shortcut.split("+");
  const rawKey = parts.pop() ?? "";
  const key = isLetter(rawKey.toLowerCase()) ? rawKey.toLowerCase() : canonicalKey(rawKey);
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  const ordered: string[] = [];
  if (mods.has("mod")) ordered.push("Mod");
  if (mods.has("alt")) ordered.push("Alt");
  if (mods.has("shift")) ordered.push("Shift");
  return [...ordered, key].join("+");
}

/** The key's display spelling: `PageUp`, `F5`, `[`, else the lowercase letter/digit. */
function canonicalKey(rawKey: string): string {
  const key = rawKey.toLowerCase();
  if (isFunctionKey(key)) return key.toUpperCase();
  const named: Record<string, string> = {
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    delete: "Delete",
    insert: "Insert",
    backspace: "Backspace",
    enter: "Enter",
  };
  return named[key] ?? rawKey;
}

/** Comparable form of a shortcut: lowercase, modifiers sorted, so `Shift+Mod+a` == `Mod+Shift+a`. */
export const normalizeShortcut = (shortcut: string): string =>
  shortcut.toLowerCase().split("+").sort().join("+");

/**
 * The shortcut a keyboard event would make, or `undefined` when the event is only modifiers or a
 * key Yavin cannot bind. Uses the physical key position (`event.code`) for letters, digits and
 * punctuation, so the result does not depend on the keyboard layout or the shifted character.
 */
export function shortcutFromEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
    code?: string;
  },
): string | undefined {
  const code = event.code ?? "";
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (CODE_PUNCTUATION[code]) key = CODE_PUNCTUATION[code];
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) key = event.key;
  else if (NAMED_KEYS.has(event.key.toLowerCase())) key = event.key;
  else if (event.key.length === 1 && /[a-z]/i.test(event.key)) key = event.key.toLowerCase();
  if (key === undefined) return undefined;
  const mods: string[] = [];
  if (event.ctrlKey || event.metaKey) mods.push("Mod");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  const assembled = [...mods, key].join("+");
  return canonicalShortcut(assembled);
}

// --- A command's effective shortcut and conflicts -----------------------------------------------

/** What the registry gives the shortcuts view and the conflict check: a command, its default and
 * what it resolves to, plus the dispatch domain its key lives in. */
export interface ShortcutBinding {
  readonly id: string;
  readonly label: string;
  readonly menu: string;
  readonly defaultShortcut?: string;
  /** The key in force: the override if there is one, else the default; `undefined` if unbound. */
  readonly shortcut?: string;
  /** How the key is set: `"default"`, `"custom"` (reassigned), or `"unbound"` (removed). */
  readonly source: "default" | "custom" | "unbound";
  /** `"terminal"`: dispatched only while a terminal has the keyboard, a separate key space. */
  readonly domain: "window" | "terminal";
}

/**
 * Which bindings collide: a map from a binding's command id to the ids of the other commands that
 * would answer the same key in the same dispatch domain. A `terminal`-scoped command and a window
 * command may share a key on purpose (the terminal takes it when focused, the window otherwise),
 * so they are never reported against each other.
 */
export function shortcutConflicts(
  bindings: readonly ShortcutBinding[],
): ReadonlyMap<string, readonly string[]> {
  const byKey = new Map<string, ShortcutBinding[]>();
  for (const binding of bindings) {
    if (!binding.shortcut) continue;
    const bucket = `${binding.domain}\u0000${normalizeShortcut(binding.shortcut)}`;
    (byKey.get(bucket) ?? byKey.set(bucket, []).get(bucket)!).push(binding);
  }
  const conflicts = new Map<string, readonly string[]>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const binding of group)
      conflicts.set(
        binding.id,
        group.filter((other) => other.id !== binding.id).map((other) => other.id),
      );
  }
  return conflicts;
}

// --- Persistence --------------------------------------------------------------------------------

export const KEYBINDINGS_VERSION = 1;
export const USER_KEYBINDINGS_KEY = "yavin.keybindings.user";

/** A binding override: a valid shortcut the user chose, or `null` for "no key" (unbound). */
export type KeybindingOverride = string | null;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export interface KeybindingsStore {
  /** The override for `commandId`, or `undefined` when there is none. */
  override(commandId: string): KeybindingOverride | undefined;
  /** Every override, command id → chosen key or `null` (unbound). A copy; never the live map. */
  overrides(): ReadonlyMap<string, KeybindingOverride>;
  /** The key in force for `commandId` given its default: the override, else the default. */
  resolve(commandId: string, defaultShortcut?: string): string | undefined;
  /** Binds `commandId` to `shortcut`. Throws `KeybindingError` for an invalid shortcut. */
  assign(commandId: string, shortcut: string): void;
  /** Removes `commandId`'s key entirely (its default no longer applies). */
  unbind(commandId: string): void;
  /** Drops the override for `commandId`: its default applies again. */
  reset(commandId: string): void;
  /** Drops every override: all defaults apply again. */
  resetAll(): void;
  /** Hears any change to the overrides. */
  subscribe(listener: () => void): () => void;
  /** What went wrong reading or writing, since last asked, for the window to say once. */
  takeProblems(): string[];
  onProblems(listener: () => void): () => void;
}

export class KeybindingError extends Error {}

export function createKeybindingsStore(
  storage: Storage | null = defaultStorage(),
): KeybindingsStore {
  const overrides = new Map<string, KeybindingOverride>();
  let frozen = false; // written by a newer Yavin: applied for this window, never saved.
  const listeners = new Set<() => void>();
  const problemListeners = new Set<() => void>();
  let problems: string[] = [];

  const report = (found: string[]) => {
    if (!found.length) return;
    problems.push(...found);
    for (const listener of [...problemListeners])
      try {
        listener();
      } catch {
        /* A listener's failure is not the store's. */
      }
  };

  const changed = () => {
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
  };

  // Load once, defensively. Every rule mirrors the settings registry's.
  (() => {
    let text: string | null = null;
    try {
      text = storage?.getItem(USER_KEYBINDINGS_KEY) ?? null;
    } catch {
      report(["Your keyboard shortcuts could not be read from storage; the defaults apply."]);
      return;
    }
    if (text === null) return;
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      body = null;
    }
    const bindings =
      body && body.bindings && typeof body.bindings === "object" && !Array.isArray(body.bindings)
        ? (body.bindings as Record<string, unknown>)
        : null;
    if (!body || !Number.isSafeInteger(body.version) || (body.version as number) < 1 || !bindings) {
      let kept = "";
      try {
        storage?.setItem(`${USER_KEYBINDINGS_KEY}.corrupt`, text);
        kept = ` What was there was kept in ${USER_KEYBINDINGS_KEY}.corrupt.`;
      } catch {
        /* Storage full: still reported. */
      }
      report([`Your keyboard shortcuts could not be read; the defaults apply.${kept}`]);
      return;
    }
    if ((body.version as number) > KEYBINDINGS_VERSION) {
      frozen = true;
      report([
        "Your keyboard shortcuts were saved by a newer version of Yavin; they are left as they are and not used.",
      ]);
      return;
    }
    const dropped: string[] = [];
    for (const [id, value] of Object.entries(bindings)) {
      if (value === null) {
        overrides.set(id, null);
        continue;
      }
      if (typeof value === "string" && isValidShortcut(value)) {
        overrides.set(id, canonicalShortcut(value)!);
        continue;
      }
      dropped.push(id);
    }
    if (dropped.length)
      report([
        `Some saved keyboard shortcuts were not valid and were ignored (${dropped.join(", ")}); their defaults apply.`,
      ]);
  })();

  const save = () => {
    if (frozen || !storage) return;
    try {
      storage.setItem(
        USER_KEYBINDINGS_KEY,
        JSON.stringify({ version: KEYBINDINGS_VERSION, bindings: Object.fromEntries(overrides) }),
      );
    } catch {
      report(["Your keyboard shortcuts could not be saved; they apply until the window closes."]);
    }
  };

  return {
    override: (commandId) => (overrides.has(commandId) ? overrides.get(commandId)! : undefined),
    overrides: () => new Map(overrides),
    resolve: (commandId, defaultShortcut) =>
      overrides.has(commandId) ? (overrides.get(commandId) ?? undefined) : defaultShortcut,
    assign(commandId, shortcut) {
      const canonical = canonicalShortcut(shortcut);
      if (canonical === undefined)
        throw new KeybindingError(`${JSON.stringify(shortcut)} is not a shortcut Yavin can use.`);
      if (overrides.get(commandId) === canonical) return;
      overrides.set(commandId, canonical);
      save();
      changed();
    },
    unbind(commandId) {
      if (overrides.get(commandId) === null) return;
      overrides.set(commandId, null);
      save();
      changed();
    },
    reset(commandId) {
      if (!overrides.has(commandId)) return;
      overrides.delete(commandId);
      save();
      changed();
    },
    resetAll() {
      if (!overrides.size) return;
      overrides.clear();
      save();
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takeProblems() {
      const taken = problems;
      problems = [];
      return taken;
    },
    onProblems(listener) {
      problemListeners.add(listener);
      return () => {
        problemListeners.delete(listener);
      };
    },
  };
}
