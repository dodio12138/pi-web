"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

// The pixel skin draws the composer's caret itself: a browser caret cannot be
// made thicker or shorter. The textarea's own caret is transparent under the
// skin (app/skin-pixel.css), and this block sits where it would be.

/** Styles that decide where text wraps and lines fall in a textarea. */
const MIRRORED = [
  "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontFeatureSettings",
  "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize",
  "whiteSpace", "overflowWrap", "wordBreak",
] as const;

let mirror: HTMLDivElement | null = null;

/** Where `position` falls inside the textarea's padding box, as its line's top and left. */
function caretCoordinates(textarea: HTMLTextAreaElement, position: number) {
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", overflow: "hidden" });
    document.body.appendChild(mirror);
  }
  const style = getComputedStyle(textarea);
  for (const name of MIRRORED) mirror.style[name] = style[name];
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = style.overflowWrap === "normal" ? "break-word" : style.overflowWrap;
  // The textarea's width less a scrollbar, if it shows one.
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${textarea.clientWidth + textarea.clientLeft * 2}px`;
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || "​";
  mirror.appendChild(marker);
  const fontSize = parseFloat(style.fontSize) || 14;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
  return {
    // Offsets count from the mirror's padding edge, as the textarea's content does.
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    lineHeight,
    fontSize,
  };
}

type Caret = { x: number; y: number; height: number; key: number };

/**
 * A blinking block caret over a textarea while it has focus and no selection.
 * `value` re-places it after the text changes from outside (send, history).
 */
export function PixelCaret({ textareaRef, enabled, value }: { textareaRef: RefObject<HTMLTextAreaElement | null>; enabled: boolean; value: string }) {
  const [caret, setCaret] = useState<Caret | null>(null);
  const updateRef = useRef<() => void>(() => {});

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) {
      setCaret(null);
      return;
    }
    let frame = 0;
    let moves = 0;
    const place = () => {
      frame = 0;
      if (document.activeElement !== textarea || textarea.selectionStart !== textarea.selectionEnd) {
        setCaret(null);
        return;
      }
      const at = caretCoordinates(textarea, textarea.selectionStart);
      const box = textarea.getBoundingClientRect();
      // Shorter than the line, a little taller than the text, centered in the line.
      const height = Math.max(10, Math.round(at.fontSize * 1.25));
      const x = box.left + textarea.clientLeft + at.left;
      const y = box.top + textarea.clientTop + at.top + (at.lineHeight - height) / 2;
      // Scrolled out of the textarea's view: no caret.
      if (y + height <= box.top || y >= box.bottom) {
        setCaret(null);
        return;
      }
      moves += 1;
      setCaret({ x, y, height, key: moves });
    };
    const update = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    updateRef.current = update;

    // keydown: the caret moves after it, and the frame that places it comes after that.
    const onTextarea = ["input", "select", "selectionchange", "keydown", "keyup", "mouseup", "focus", "blur", "scroll"] as const;
    for (const type of onTextarea) textarea.addEventListener(type, update);
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const resize = new ResizeObserver(update);
    resize.observe(textarea);
    update();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      for (const type of onTextarea) textarea.removeEventListener(type, update);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      resize.disconnect();
      updateRef.current = () => {};
    };
  }, [enabled, textareaRef]);

  useEffect(() => {
    updateRef.current();
  }, [value]);

  if (!enabled || !caret) return null;
  // A new key per move restarts the blink, so the caret shows solid while typing.
  return createPortal(
    <span key={caret.key} className="pixel-caret" aria-hidden="true" style={{ left: caret.x, top: caret.y, height: caret.height }} />,
    document.body,
  );
}
