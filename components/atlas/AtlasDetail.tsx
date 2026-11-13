"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "../MarkdownBody";
import {
  atlasApi,
  ATTRIBUTION_LABEL,
  BOOK_RELATION_TYPES,
  COVERAGE_LABEL,
  KNOWLEDGE_RELATION_TYPES,
  NODE_TYPE_LABEL,
  patchProblem,
  RELATION_LABEL,
  VERIFICATION_LABEL,
  type AtlasTag,
  type GraphCard,
  type ObjectView,
} from "./atlas-client";

// One card in full: read it, edit it (title, summary, Markdown body; a book's
// authors, 中图法 classes and entry questions), change its tags and
// relations, trace its sources, and ask about it in the chat. Every save is a
// patch with the revision the user started from, so an Agent edit in between
// is a conflict and the draft is kept, never silently overwritten.

interface Props {
  id: string;
  tags: AtlasTag[];
  /** Cards on the canvas, to pick a relation target from. */
  cards: GraphCard[];
  onAsk: (action: string) => void;
  /** For a book: walk it through the reading lenses in the chat (/atlas guide). */
  onGuide?: (title: string) => void;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onChanged: () => void;
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
}

const ACTIONS = ["解释", "举例", "比较", "质疑", "应用练习"];

interface Draft {
  title: string;
  summary: string;
  body: string;
  aliases: string;
  authors: string;
  year: string;
  codes: string;
  questions: string;
}

function draftOf(view: ObjectView): Draft {
  const o = view.object as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join("、") : "");
  return {
    title: String(o.title ?? ""),
    summary: String(o.summary ?? ""),
    body: String(o.body ?? ""),
    aliases: list(o.aliases),
    authors: list(o.authors),
    year: o.published_year == null ? "" : String(o.published_year),
    codes: list((o.classification as { codes?: string[] } | undefined)?.codes),
    questions: Array.isArray(o.entry_questions) ? (o.entry_questions as string[]).join("\n") : "",
  };
}

const split = (s: string) => s.split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);

export function AtlasDetail({ id, tags, cards, onAsk, onGuide, onSelect, onHide, onChanged, onOpenSession, onClose }: Props) {
  const [view, setView] = useState<ObjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The version the draft started from, to merge with a newer one field by field.
  const [base, setBase] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [relation, setRelation] = useState<{ to: string; type: string } | null>(null);
  const isBook = id.startsWith("book-");

  const load = useCallback(async () => {
    try {
      const next = await atlasApi.read(id);
      setView(next);
      setError(null);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  const startEdit = () => {
    if (!view) return;
    setDraft(draftOf(view));
    setBase(draftOf(view));
  };

  // After a conflict: fields the user did not touch take the newer values, the
  // user's edits stay; where both changed a field the user's text is kept and
  // the newer text is named, so neither side is lost.
  const mergeLatest = async () => {
    const latest = await load();
    if (!latest || !draft || !base) return;
    const theirs = draftOf(latest);
    const merged = { ...draft };
    const clashes: string[] = [];
    for (const key of Object.keys(draft) as (keyof Draft)[]) {
      const mine = draft[key] !== base[key];
      const changed = theirs[key] !== base[key];
      if (!mine) merged[key] = theirs[key];
      else if (changed && theirs[key] !== draft[key]) clashes.push(key);
    }
    setDraft(merged);
    setBase(theirs);
    const names: Record<string, string> = { title: "标题", summary: "概括", body: "正文", aliases: "别名", authors: "作者", year: "出版年份", codes: "分类", questions: "入口问题" };
    setProblem(clashes.length
      ? `已合并最新版本。${clashes.map((k) => names[k]).join("、")}两边都改过，保留了你的内容；另一版：${clashes.map((k) => `「${theirs[k as keyof Draft].slice(0, 80)}」`).join(" ")}`
      : null);
  };
  useEffect(() => { setDraft(null); setBase(null); setProblem(null); setRelation(null); void load(); }, [load]);

  const apply = async (operations: unknown[], withRevision = false) => {
    if (!view) return false;
    setSaving(true);
    try {
      const result = await atlasApi.patch(operations, withRevision ? { [id]: view.object.revision } : undefined);
      if (!result.ok) { setProblem(patchProblem(result)); return false; }
      setProblem(null);
      await load();
      onChanged();
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!draft || !view) return;
    const changes: Record<string, unknown> = { title: draft.title.trim(), body: draft.body };
    if (isBook) {
      changes.authors = split(draft.authors);
      const year = draft.year.trim();
      if (year && !/^-?\d+$/.test(year)) { setProblem("出版年份要写整数，公元前写负数"); return; }
      changes.published_year = year ? Number(year) : null;
      changes.entry_questions = draft.questions.split("\n").map((q) => q.trim()).filter(Boolean);
      const codes = split(draft.codes).map((c) => c.toUpperCase());
      changes.classification = codes.length ? { scheme_id: "clc", scheme_version: "5", codes } : { scheme_id: null, scheme_version: null, codes: [] };
    } else {
      changes.summary = draft.summary.trim();
      changes.aliases = split(draft.aliases);
    }
    if (await apply([{ op: isBook ? "update_book" : "update_node", id, changes }], true)) { setDraft(null); setBase(null); }
  };

  const addTag = async () => {
    const name = tagInput.trim();
    if (!name) return;
    const existing = tags.find((t) => t.name === name || t.aliases.includes(name));
    const binding = { coverage: "core", assigned_by: "human", source_refs: [] };
    const ok = existing
      ? await apply([{ op: "bind_tag", target_id: id, binding: { ...binding, tag_id: existing.id } }])
      : await apply([{ op: "create_tag", ref: "$t", fields: { type: "topic", name } }, { op: "bind_tag", target_id: id, binding: { ...binding, tag_id: "$t" } }]);
    if (ok) setTagInput("");
  };

  const addRelation = async () => {
    if (!relation?.to || !relation.type) return;
    const ok = await apply([{ op: "create_relation", fields: { from_id: id, to_id: relation.to, type: relation.type, attribution: "user_understanding" } }]);
    if (ok) setRelation(null);
  };

  const targets = useMemo(() => cards.filter((c) => c.id !== id && (!isBook || c.kind === "node")), [cards, id, isBook]);
  const relationTypes = isBook ? BOOK_RELATION_TYPES : KNOWLEDGE_RELATION_TYPES;

  if (error) return <aside className="atlas-detail"><div className="atlas-detail-problem">{error}</div></aside>;
  if (!view) return <aside className="atlas-detail"><div className="atlas-dim">载入中…</div></aside>;
  const o = view.object as Record<string, unknown>;
  const type = isBook ? "book" : String(o.type);

  return (
    <aside className="atlas-detail" aria-label="节点详情">
      <header className="atlas-detail-head">
        <span className="atlas-card-type">{NODE_TYPE_LABEL[type] ?? type}</span>
        {!isBook && <span className="atlas-chip">{ATTRIBUTION_LABEL[String(o.attribution)] ?? String(o.attribution)}</span>}
        <span className="atlas-chip">{VERIFICATION_LABEL[String(o.verification)] ?? String(o.verification)}</span>
        <span className="atlas-dim atlas-mono">r{view.object.revision}</span>
        <span style={{ flex: 1 }} />
        {!draft && <button type="button" className="atlas-btn" onClick={startEdit}>编辑</button>}
        <button type="button" className="atlas-btn atlas-btn-icon" onClick={onClose} title="关闭" aria-label="关闭">×</button>
      </header>

      {problem && (
        <div className="atlas-detail-problem">
          {problem}
          {draft && problem.startsWith("这张卡片已被别处修改") && <button type="button" className="atlas-btn" onClick={() => void mergeLatest()}>合并最新版本</button>}
        </div>
      )}

      {draft ? (
        <div className="atlas-form">
          <label>标题<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          {isBook ? (
            <>
              <label>作者<input value={draft.authors} onChange={(e) => setDraft({ ...draft, authors: e.target.value })} placeholder="用顿号分隔" /></label>
              <label>首次出版年份<input value={draft.year} onChange={(e) => setDraft({ ...draft, year: e.target.value })} placeholder="如 1651，公元前写负数；不确定就留空" inputMode="numeric" /></label>
              <label>中图法分类<input value={draft.codes} onChange={(e) => setDraft({ ...draft, codes: e.target.value })} placeholder="主类在前，如 D0、B5" /></label>
              <label>入口问题<textarea rows={3} value={draft.questions} onChange={(e) => setDraft({ ...draft, questions: e.target.value })} placeholder="每行一个" /></label>
            </>
          ) : (
            <>
              <label>一句话概括<input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
              <label>别名<input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="用顿号分隔" /></label>
            </>
          )}
          <label>正文（Markdown）<textarea rows={12} className="atlas-mono" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
          <div className="atlas-row">
            <button type="button" className="atlas-btn atlas-btn-primary" disabled={saving || !draft.title.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
            <button type="button" className="atlas-btn" onClick={() => { setDraft(null); setBase(null); setProblem(null); }}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <h3 className="atlas-detail-title">{String(o.title ?? "")}</h3>
          {isBook ? (
            <div className="atlas-detail-meta">
              {Array.isArray(o.authors) && o.authors.length > 0 && <div>{(o.authors as string[]).join("、")}{o.published_year != null && `，${Number(o.published_year) < 0 ? `公元前 ${-Number(o.published_year)}` : String(o.published_year)} 年`}</div>}
              {Array.isArray((o.classification as { codes?: string[] })?.codes) && (o.classification as { codes: string[] }).codes.length > 0 && (
                <div className="atlas-mono">中图法 {(o.classification as { codes: string[] }).codes.join(" · ")}</div>
              )}
              {Array.isArray(o.entry_questions) && (o.entry_questions as string[]).map((q) => <div key={q} className="atlas-question">？{q}</div>)}
            </div>
          ) : (
            o.summary ? <p className="atlas-detail-summary">{String(o.summary)}</p> : null
          )}
          <div className="atlas-row atlas-wrap">
            {isBook && onGuide && (
              <button type="button" className="atlas-btn atlas-btn-primary" onClick={() => onGuide(String(o.title ?? ""))} title="让 Agent 用八个读书透镜带你过一遍这本书，并整理书卡、分类和标签">读书透镜引导</button>
            )}
            {ACTIONS.map((action) => (
              <button key={action} type="button" className="atlas-btn" onClick={() => onAsk(action)} title={`把这张卡片带进对话：${action}`}>{action}</button>
            ))}
          </div>
          {String(o.body ?? "").trim() && <div className="atlas-detail-body"><MarkdownBody>{String(o.body)}</MarkdownBody></div>}
        </>
      )}

      <section className="atlas-detail-section">
        <h4>标签</h4>
        <div className="atlas-row atlas-wrap">
          {view.tags.map((tag) => (
            <span key={tag.id} className={`atlas-chip atlas-chip-${tag.coverage}`} title={COVERAGE_LABEL[tag.coverage]}>
              {tag.name}
              <button type="button" aria-label={`移除标签 ${tag.name}`} onClick={() => void apply([{ op: "unbind_tag", target_id: id, tag_id: tag.id }])}>×</button>
            </span>
          ))}
          <input
            className="atlas-tag-input"
            list="atlas-tag-names"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addTag(); }}
            placeholder="+ 标签"
          />
          <datalist id="atlas-tag-names">{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        </div>
      </section>

      <section className="atlas-detail-section">
        <h4>关系</h4>
        {view.relations.length === 0 && <div className="atlas-dim">还没有关系</div>}
        {view.relations.map((r) => (
          <div key={r.id} className="atlas-relation">
            <span className="atlas-dim">{r.direction === "out" ? "→" : "←"}</span>
            <span className={`atlas-rel-type atlas-edge-${r.type}`}>{RELATION_LABEL[r.type] ?? r.type}</span>
            <button type="button" className="atlas-link" onClick={() => onSelect(r.other_id)}>{r.other_title}</button>
            <span className="atlas-dim" title={ATTRIBUTION_LABEL[r.attribution]}>{ATTRIBUTION_LABEL[r.attribution] ?? ""}</span>
            <button type="button" className="atlas-btn atlas-btn-icon" title="移除这条关系（归档，可恢复）" aria-label="移除关系" onClick={() => void apply([{ op: "archive", id: r.id }])}>×</button>
          </div>
        ))}
        {relation ? (
          <div className="atlas-row atlas-wrap">
            <select value={relation.type} onChange={(e) => setRelation({ ...relation, type: e.target.value })}>
              {relationTypes.map((t) => <option key={t} value={t}>{RELATION_LABEL[t]}</option>)}
            </select>
            <select value={relation.to} onChange={(e) => setRelation({ ...relation, to: e.target.value })}>
              <option value="">选择画板上的卡片…</option>
              {targets.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <button type="button" className="atlas-btn atlas-btn-primary" disabled={!relation.to || saving} onClick={() => void addRelation()}>连线</button>
            <button type="button" className="atlas-btn" onClick={() => setRelation(null)}>取消</button>
          </div>
        ) : (
          <button type="button" className="atlas-btn" onClick={() => setRelation({ to: "", type: relationTypes[0] })}>+ 连线</button>
        )}
      </section>

      <section className="atlas-detail-section">
        <h4>来源</h4>
        {view.sources.length === 0 && <div className="atlas-dim">没有来源记录</div>}
        {view.sources.map((s) => (
          <div key={s.id} className="atlas-source">
            <span className="atlas-chip">{s.kind === "conversation" ? "对话" : s.kind}</span>
            <span>{s.title}</span>
            <span className="atlas-dim">{VERIFICATION_LABEL[s.verification] ?? s.verification}</span>
            {s.kind === "conversation" && s.locator?.session_id && onOpenSession && (
              <button type="button" className="atlas-link" onClick={() => onOpenSession(s.locator!.session_id)}>追溯讨论</button>
            )}
            {s.url && <a className="atlas-link" href={s.url} target="_blank" rel="noreferrer">链接</a>}
          </div>
        ))}
      </section>

      <footer className="atlas-row atlas-detail-foot">
        <button type="button" className="atlas-btn" onClick={() => onHide(id)} title="只从这个视图移除，不删除知识">从画板移除</button>
        <button
          type="button"
          className="atlas-btn atlas-btn-danger"
          onClick={() => { if (window.confirm(`归档「${String(o.title)}」？归档后默认不显示，文件保留，可以恢复。`)) void apply([{ op: "archive", id }]).then((ok) => ok && onClose()); }}
        >归档</button>
        <span className="atlas-dim atlas-mono" style={{ marginLeft: "auto" }}>{id}</span>
      </footer>
    </aside>
  );
}
