import { useEffect, useRef, type RefObject } from "react";

/**
 * SPEC_10 §b: dismiss a click-to-toggle floating panel (popover/menu/dropdown)
 * on outside-click or Escape, wherever it's used in the app.
 *
 * Attach the returned ref to the DOM subtree that should count as "inside" —
 * typically the element wrapping BOTH the trigger button and the panel
 * itself. Wrapping the trigger too means a click that re-toggles the panel
 * is handled entirely by the trigger's own onClick instead of racing with
 * this hook's outside-click listener (which would otherwise fire first on
 * `mousedown`, close the panel, and then the trigger's `click` handler would
 * immediately reopen it).
 *
 * Listeners are only attached while `open` is true, and torn down on close
 * or unmount.
 */
export function useDismissablePopover<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  /** Optional: focus moves back here after Escape closes the panel. */
  returnFocusRef?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
  const containerRef = useRef<T | null>(null);
  // Keep the latest onClose without re-subscribing listeners every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        returnFocusRef?.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, returnFocusRef]);

  return containerRef;
}
