"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CARD_H, CARD_W, type Point } from "./atlas-layout";
import { ATTRIBUTION_LABEL, NODE_TYPE_LABEL, RELATION_LABEL, VERIFICATION_LABEL, type GraphCard, type GraphEdge } from "./atlas-client";

// The node canvas: cards are HTML over an SVG layer of edges, all inside one
// transformed plane. Drag the background to pan, the wheel to zoom, a card to
// move it (saved when dropped). Click selects, shift-click adds to the
// selection, a double click or the +n badge opens a card's neighbours.

interface Props {
  cards: GraphCard[];
  edges: GraphEdge[];
  positions: Record<string, Point>;
  selected: string[];
  /** Cards added or changed since the user last looked. */
  fresh: Set<string>;
  onSelect: (ids: string[]) => void;
  onMove: (id: string, p: Point) => void;
  onExpand: (id: string) => void;
}

interface View { x: number; y: number; k: number }

export function AtlasCanvas({ cards, edges, positions, selected, fresh, onSelect, onMove, onExpand }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [drag, setDrag] = useState<{ id: string; p: Point } | null>(null);
  // The card under the pointer: it and its neighbours stay lit, the rest fade.
  const [hover, setHover] = useState<string | null>(null);
  // Its details show after a short rest, so passing over cards stays quiet.
  const [peek, setPeek] = useState<string | null>(null);
  const peekTimer = useRef<number | null>(null);
  const enterCard = (id: string) => {
    setHover(id);
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(id), 350);
  };
  const leaveCard = () => {
    setHover(null);
    setPeek(null);
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
  };
  useEffect(() => () => { if (peekTimer.current) window.clearTimeout(peekTimer.current); }, []);
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const fitted = useRef(false);
  // Once the user pans or zooms, a resize no longer refits the view.
  const touched = useRef(false);
  const cardEls = useRef(new Map<string, HTMLDivElement>());

  const posOf = useCallback((id: string): Point | undefined => (drag?.id === id ? drag.p : positions[id]), [drag, positions]);

  // Measure cards for edge endpoints.
  useLayoutEffect(() => {
    const next: Record<string, { w: number; h: number }> = {};
    let changed = false;
    for (const [id, el] of cardEls.current) {
      const s = { w: el.offsetWidth, h: el.offsetHeight };
      next[id] = s;
      if (sizes[id]?.w !== s.w || sizes[id]?.h !== s.h) changed = true;
    }
    if (changed || Object.keys(next).length !== Object.keys(sizes).length) setSizes(next);
  }, [cards, sizes]);

  const fit = useCallback(() => {
    const el = host.current;
    const pts = cards.map((c) => positions[c.id]).filter(Boolean);
    if (!el || pts.length === 0) return;
    const minX = Math.min(...pts.map((p) => p.x)) - CARD_W / 2 - 40;
    const maxX = Math.max(...pts.map((p) => p.x)) + CARD_W / 2 + 40;
    const minY = Math.min(...pts.map((p) => p.y)) - CARD_H / 2 - 40;
    const maxY = Math.max(...pts.map((p) => p.y)) + CARD_H / 2 + 40;
    const k = Math.min(1.2, Math.max(0.25, Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY))));
    setView({ k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: el.clientHeight / 2 - ((minY + maxY) / 2) * k });
  }, [cards, positions]);

  // Fit once when the first cards arrive; later changes keep the user's view.
  useEffect(() => {
    if (fitted.current || cards.length === 0 || cards.some((c) => !positions[c.id])) return;
    fitted.current = true;
    fit();
  }, [cards, positions, fit]);
  const cardKey = cards.length === 0 ? "" : cards[0].id;
  useEffect(() => { if (cards.length === 0) { fitted.current = false; touched.current = false; } }, [cardKey, cards.length]);

  // The panel opens narrow and is often widened: keep the cards in view until the user moves the view.
  const fitRef = useRef(fit);
  useEffect(() => { fitRef.current = fit; }, [fit]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (fitted.current && !touched.current) fitRef.current(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom around the pointer (non-passive so the page does not scroll).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touched.current = true;
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))));
        return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    touched.current = true;
    const el = host.current;
    if (!el) return;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * factor));
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    });
  };

  const onBackgroundDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".atlas-card, .atlas-canvas-tools")) return;
    const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    let moved = false;
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3) { moved = true; touched.current = true; }
      setView((v) => ({ ...v, x: start.vx + e.clientX - start.x, y: start.vy + e.clientY - start.y }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) onSelect([]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onCardDown = (event: React.PointerEvent, card: GraphCard) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.stopPropagation();
    const origin = positions[card.id];
    if (!origin) return;
    const start = { x: event.clientX, y: event.clientY };
    let current = origin;
    let moved = false;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.x) / view.k;
      const dy = (e.clientY - start.y) / view.k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      current = { x: origin.x + dx, y: origin.y + dy };
      setDrag({ id: card.id, p: current });
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (moved) onMove(card.id, current);
      else if (e.shiftKey || e.metaKey || e.ctrlKey) onSelect(selected.includes(card.id) ? selected.filter((id) => id !== card.id) : [...selected, card.id]);
      else onSelect([card.id]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const edgePaths = useMemo(() => edges.map((edge) => {
    const a = posOf(edge.from);
    const b = posOf(edge.to);
    if (!a || !b) return null;
    const sa = sizes[edge.from] ?? { w: CARD_W, h: CARD_H };
    const sb = sizes[edge.to] ?? { w: CARD_W, h: CARD_H };
    // Clip the centre-to-centre line at each card's border.
    const clip = (from: Point, to: Point, s: { w: number; h: number }) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const t = Math.min(Math.abs((s.w / 2 + 4) / (dx || 1e-6)), Math.abs((s.h / 2 + 4) / (dy || 1e-6)), 0.5);
      return { x: from.x + dx * t, y: from.y + dy * t };
    };
    const p1 = clip(a, b, sa);
    const p2 = clip(b, a, sb);
    // A gentle arc, bent the same way every time for an edge, keeps crossing lines apart.
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    let bend = 0;
    for (let i = 0; i < edge.id.length; i += 1) bend = (bend * 31 + edge.id.charCodeAt(i)) % 997;
    const k = (bend % 2 ? 1 : -1) * Math.min(60, len * 0.12);
    const c = { x: (p1.x + p2.x) / 2 - (dy / len) * k, y: (p1.y + p2.y) / 2 + (dx / len) * k };
    const mid = { x: 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y };
    return { edge, p1, p2, c, mid };
  }).filter((x): x is NonNullable<typeof x> => Boolean(x)), [edges, posOf, sizes]);

  const selectedSet = new Set(selected);
  // Focus: the hovered or selected cards and their neighbours stay lit, the rest fade back.
  const focus = new Set([...selected, ...(hover ? [hover] : [])]);
  const lit = new Set(focus);
  for (const e of edges) {
    if (focus.has(e.from)) lit.add(e.to);
    if (focus.has(e.to)) lit.add(e.from);
  }
  const focused = focus.size > 0;
  const edgeLit = (e: GraphEdge) => focus.has(e.from) || focus.has(e.to);
  // Relation names: all of them while there are few lines, otherwise only the focused card's.
  const showLabel = (e: GraphEdge) => (focused ? edgeLit(e) : edges.length <= 12);
  const peekCard = peek && !drag ? cards.find((c) => c.id === peek) : undefined;
  const peekPos = peekCard ? posOf(peekCard.id) : undefined;
  const peekSize = peekCard ? sizes[peekCard.id] ?? { w: CARD_W, h: CARD_H } : undefined;
  const degree = (id: string) => edges.filter((e) => e.from === id || e.to === id).length;

  return (
    <div ref={host} className="atlas-canvas" onPointerDown={onBackgroundDown}>
      <div className="atlas-plane" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="atlas-edges" width="1" height="1" aria-hidden="true">
          <defs>
            <marker id="atlas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {edgePaths.map(({ edge, p1, p2, c }) => {
            const active = edgeLit(edge);
            const symmetric = edge.type === "related_to" || edge.type === "compares";
            return (
              <path
                key={edge.id}
                d={`M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`}
                className={`atlas-edge atlas-edge-${edge.type}${active ? " is-active" : ""}${focused && !active ? " is-dim" : ""}`}
                markerEnd={symmetric ? undefined : "url(#atlas-arrow)"}
              />
            );
          })}
        </svg>
        {edgePaths.filter(({ edge }) => showLabel(edge)).map(({ edge, mid }) => (
          <div key={`l-${edge.id}`} className={`atlas-edge-label atlas-edge-${edge.type}${edgeLit(edge) ? " is-active" : ""}`} style={{ left: mid.x, top: mid.y }} title={edge.note ?? undefined}>
            {RELATION_LABEL[edge.type] ?? edge.type}
          </div>
        ))}
        {cards.map((card) => {
          const p = posOf(card.id);
          if (!p) return null;
          return (
            <div
              key={card.id}
              ref={(el) => { if (el) cardEls.current.set(card.id, el); else cardEls.current.delete(card.id); }}
              className={`atlas-card atlas-card-${card.type}${selectedSet.has(card.id) ? " is-selected" : ""}${fresh.has(card.id) ? " is-fresh" : ""}${drag?.id === card.id ? " is-dragging" : ""}${focused && !lit.has(card.id) ? " is-dim" : ""}`}
              style={{ left: p.x, top: p.y, width: CARD_W }}
              onPointerDown={(event) => onCardDown(event, card)}
              onDoubleClick={() => onExpand(card.id)}
              onPointerEnter={() => enterCard(card.id)}
              onPointerLeave={leaveCard}
              role="button"
              tabIndex={0}
              aria-pressed={selectedSet.has(card.id)}
              onKeyDown={(event) => { if (event.key === "Enter") onSelect([card.id]); }}
            >
              <div className="atlas-card-head">
                <span className="atlas-card-type">{NODE_TYPE_LABEL[card.type] ?? card.type}</span>
                {card.kind === "node" && card.verification !== "verified" && (
                  <span className="atlas-card-state" title={VERIFICATION_LABEL[card.verification]}>{VERIFICATION_LABEL[card.verification] ?? card.verification}</span>
                )}
                {card.more > 0 && (
                  <button type="button" className="atlas-card-more" title={`展开 ${card.more} 个相邻节点`} onClick={() => onExpand(card.id)}>+{card.more}</button>
                )}
              </div>
              <div className="atlas-card-title">{card.title}</div>
              {card.subtitle && <div className="atlas-card-sub">{card.subtitle}</div>}
              {card.summary && <div className="atlas-card-summary">{card.summary}</div>}
            </div>
          );
        })}
      </div>
      {peekCard && peekPos && peekSize && (
        <div
          className="atlas-peek"
          role="tooltip"
          style={(() => {
            // Beside the card, on whichever side has room; never off the canvas.
            const width = host.current?.clientWidth ?? 0;
            const height = host.current?.clientHeight ?? 0;
            const right = (peekPos.x + peekSize.w / 2) * view.k + view.x + 10;
            const left = (peekPos.x - peekSize.w / 2) * view.k + view.x - 10 - 260;
            const x = right + 260 <= width || left < 0 ? Math.min(right, Math.max(10, width - 270)) : left;
            const y = Math.max(10, Math.min((peekPos.y - peekSize.h / 2) * view.k + view.y, height - 200));
            return { left: x, top: y };
          })()}
        >
          <div className="atlas-peek-head">
            <span className="atlas-card-type">{NODE_TYPE_LABEL[peekCard.type] ?? peekCard.type}</span>
            {peekCard.attribution && <span className="atlas-chip">{ATTRIBUTION_LABEL[peekCard.attribution] ?? peekCard.attribution}</span>}
            {peekCard.kind === "node" && <span className="atlas-chip">{VERIFICATION_LABEL[peekCard.verification] ?? peekCard.verification}</span>}
          </div>
          <div className="atlas-peek-title">{peekCard.title}</div>
          {peekCard.subtitle && <div className="atlas-card-sub">{peekCard.subtitle}</div>}
          {peekCard.summary && <p className="atlas-peek-summary">{peekCard.summary}</p>}
          {peekCard.tags.length > 0 && <div className="atlas-peek-tags">{peekCard.tags.map((t) => <span key={t} className="atlas-chip">{t}</span>)}</div>}
          <div className="atlas-dim">
            {degree(peekCard.id)} 条关系{peekCard.more > 0 ? `，还有 ${peekCard.more} 个相邻节点未展开` : ""} · 点击看全文
          </div>
        </div>
      )}
      <div className="atlas-canvas-tools">
        <button type="button" onClick={() => zoomBy(1.25)} title="放大" aria-label="放大">+</button>
        <button type="button" onClick={() => zoomBy(0.8)} title="缩小" aria-label="缩小">−</button>
        <button type="button" onClick={() => { touched.current = false; fit(); }} title="适应窗口" aria-label="适应窗口">⤢</button>
      </div>
    </div>
  );
}
