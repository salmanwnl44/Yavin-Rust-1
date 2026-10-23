/**
 * An extension's picker or input box (EXT-29: VS Code's `showQuickPick` and `showInputBox`), in
 * the style of Yavin's own dialogs (`AppDialog`), always naming the extension that asks -- so it
 * is never taken for Yavin's own. One is shown at a time (`services/extensions/prompts.ts`).
 *
 * - **Picker.** A filter (by label; by description and detail when the extension asks), the
 *   list with descriptions and details, separators, and -- with `canPickMany` -- checkboxes
 *   (Space toggles, Enter accepts what is checked). Enter picks; Escape cancels.
 * - **Input box.** The prompt, a placeholder, the initial value and its selection, a password
 *   field, and the extension's validation as the user types (an error blocks accepting).
 * - **Cancelling.** Escape, Cancel, or a click outside -- unless the extension asked for it to
 *   stay open when the focus moves elsewhere (`ignoreFocusOut`).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PromptService, ShownPrompt } from "../../services/extensions/prompts";
import type {
  PromptValidation,
  QuickPickRequest,
  InputBoxRequest,
} from "../../services/extensions/window";

const VALIDATE_DELAY_MS = 150;

export function ExtensionPrompt({ prompts }: { prompts: PromptService }) {
  const shown = useSyncExternalStore(prompts.subscribe, prompts.getSnapshot);
  if (!shown) return null;
  return <PromptDialog key={shown.id} shown={shown} prompts={prompts} />;
}

function PromptDialog({ shown, prompts }: { shown: ShownPrompt; prompts: PromptService }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement);
  const { request } = shown;
  const cancel = () => prompts.answer(shown.id, null);
  useEffect(() => {
    ref.current?.showModal();
    return () => {
      // As AppDialog: the keyboard goes back to what had it (the editor), unless taken meanwhile.
      const previous = opener.current;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const title = request.title ?? (request.kind === "quickPick" ? "Pick an item" : "Enter a value");
  return (
    <dialog
      ref={ref}
      aria-labelledby="extension-prompt-title"
      data-extension-prompt={request.extensionId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !request.ignoreFocusOut) cancel();
      }}
      className="m-auto max-h-[80vh] w-[min(560px,90vw)] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6 text-zinc-100 backdrop:bg-black/70"
    >
      <h2 id="extension-prompt-title" className="mb-1 text-lg">
        {title}
      </h2>
      <p className="mb-3 text-xs text-zinc-500">{request.extensionName} asks</p>
      {request.kind === "quickPick" ? (
        <QuickPick
          request={request}
          answer={(value) => prompts.answer(shown.id, value)}
          cancel={cancel}
        />
      ) : (
        <InputBox
          request={request}
          answer={(value) => prompts.answer(shown.id, value)}
          cancel={cancel}
        />
      )}
    </dialog>
  );
}

function QuickPick({
  request,
  answer,
  cancel,
}: {
  request: QuickPickRequest;
  answer(value: number | number[]): void;
  cancel(): void;
}) {
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [checked, setChecked] = useState(
    () => new Set(request.items.flatMap((item, i) => (item.picked && !item.separator ? [i] : []))),
  );
  /** The items shown: their index in the request, filtered (separators kept between matches). */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (i: number) => {
      const item = request.items[i];
      if (!needle) return true;
      return (
        item.label.toLowerCase().includes(needle) ||
        (request.matchOnDescription && !!item.description?.toLowerCase().includes(needle)) ||
        (request.matchOnDetail && !!item.detail?.toLowerCase().includes(needle))
      );
    };
    const out: number[] = [];
    request.items.forEach((item, i) => {
      if (item.separator) {
        if (!needle) out.push(i);
      } else if (matches(i)) out.push(i);
    });
    return out;
  }, [request, filter]);
  const choosable = visible.filter((i) => !request.items[i].separator);
  useEffect(() => {
    setActive((prev) => Math.min(prev, Math.max(0, choosable.length - 1)));
  }, [choosable.length]);
  const current = choosable[active];
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const accept = () => {
    if (request.canPickMany) answer([...checked].sort((a, b) => a - b));
    else if (current !== undefined) answer(current);
  };
  const optionId = (i: number) => `extension-prompt-option-${i}`;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        accept();
      }}
    >
      <input
        role="combobox"
        aria-expanded
        aria-controls="extension-prompt-options"
        aria-activedescendant={current !== undefined ? optionId(current) : undefined}
        aria-label={request.title ?? "Pick an item"}
        autoFocus
        placeholder={request.placeHolder ?? "Type to filter…"}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((i) => Math.min(i + 1, choosable.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (
            event.key === " " &&
            request.canPickMany &&
            current !== undefined &&
            filter === ""
          ) {
            // Space checks the active item while nothing is typed (then it types a space).
            event.preventDefault();
            toggle(current);
          }
        }}
        className="mb-2 w-full rounded border border-zinc-600 bg-black p-2"
      />
      <ul
        id="extension-prompt-options"
        role="listbox"
        aria-multiselectable={request.canPickMany || undefined}
        aria-label={request.title ?? "Items"}
        className="mb-4 max-h-[45vh] overflow-y-auto rounded border border-zinc-800"
      >
        {choosable.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No matches.</li>}
        {visible.map((i) => {
          const item = request.items[i];
          if (item.separator)
            return (
              <li
                key={i}
                role="separator"
                className="border-t border-zinc-800 px-3 pt-1 text-xs text-zinc-500"
              >
                {item.label}
              </li>
            );
          const isActive = i === current;
          return (
            <li key={i} role="presentation">
              <button
                id={optionId(i)}
                type="button"
                role="option"
                aria-selected={request.canPickMany ? checked.has(i) : isActive}
                tabIndex={-1}
                onMouseEnter={() => setActive(choosable.indexOf(i))}
                onClick={() => (request.canPickMany ? toggle(i) : answer(i))}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm ${
                  isActive ? "bg-indigo-600 text-white" : "text-zinc-100"
                }`}
              >
                {request.canPickMany && (
                  <input
                    type="checkbox"
                    readOnly
                    tabIndex={-1}
                    checked={checked.has(i)}
                    className="mt-1"
                    aria-hidden
                  />
                )}
                <span className="flex flex-col gap-0.5">
                  <span>
                    {item.label}
                    {item.description && (
                      <span
                        className={`ml-2 text-xs ${isActive ? "text-indigo-200" : "text-zinc-500"}`}
                      >
                        {item.description}
                      </span>
                    )}
                  </span>
                  {item.detail && (
                    <span className={`text-xs ${isActive ? "text-indigo-200" : "text-zinc-500"}`}>
                      {item.detail}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        {request.canPickMany && (
          <button type="submit" className="rounded bg-indigo-600 px-4 py-2">
            OK
          </button>
        )}
      </div>
    </form>
  );
}

const SEVERITY_CLASS: Record<PromptValidation["severity"], string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-sky-400",
};

function InputBox({
  request,
  answer,
  cancel,
}: {
  request: InputBoxRequest;
  answer(value: string): void;
  cancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.value);
  const [validation, setValidation] = useState<PromptValidation | null>(null);
  const [checking, setChecking] = useState(false);
  /** Only the latest value's validation is shown (answers to older values are dropped). */
  const latest = useRef(0);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    const [start, end] = request.valueSelection ?? [0, request.value.length];
    field.setSelectionRange(start, end);
  }, [request]);
  const validate = async (text: string) => {
    if (!request.validate) return null;
    const ticket = ++latest.current;
    setChecking(true);
    const result = await request.validate(text);
    if (ticket === latest.current) {
      setValidation(result);
      setChecking(false);
    }
    return result;
  };
  useEffect(() => {
    if (!request.validate) return;
    const timer = setTimeout(() => void validate(value), VALIDATE_DELAY_MS);
    return () => clearTimeout(timer);
    // The latest value, after a pause in typing.
  }, [value]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        // Accepting checks the value as it is now: an error keeps the box open.
        const result = await validate(value);
        if (result && result.severity === "error") return;
        answer(value);
      }}
    >
      <input
        ref={input}
        aria-label={request.prompt ?? request.title ?? "Value"}
        aria-invalid={validation?.severity === "error" || undefined}
        aria-describedby="extension-prompt-message"
        type={request.password ? "password" : "text"}
        placeholder={request.placeHolder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="mb-2 w-full rounded border border-zinc-600 bg-black p-2"
      />
      <p
        id="extension-prompt-message"
        className="mb-4 min-h-5 text-sm"
        role={validation ? "alert" : undefined}
      >
        {validation ? (
          <span className={SEVERITY_CLASS[validation.severity]}>{validation.message}</span>
        ) : (
          <span className="text-zinc-400">{request.prompt ?? ""}</span>
        )}
      </p>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={checking && validation?.severity === "error"}
          className="rounded bg-indigo-600 px-4 py-2"
        >
          OK
        </button>
      </div>
    </form>
  );
}
