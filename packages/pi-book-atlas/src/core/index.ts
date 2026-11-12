// Knowledge Core: the Atlas data model, storage, patches, search and backups.
// The pi extension and the pi-web panel both go through this module, so the
// Agent and the UI share one set of rules and one writer per library.

export * from "./schema";
export { newId, nowIso } from "./ids";
export { parseFrontMatter, serializeFrontMatter } from "./frontmatter";
export { AtlasStorage, LockError, writeFileAtomic } from "./storage";
export { AtlasStore, openAtlas, type Operation, type PatchConflict, type PatchRequest, type PatchResult, type OpenReport, type LoadProblem } from "./store";
export { findTagsByLabel, normalizeLabel, resolveTag } from "./tags";
export { search, tokenize, type SearchHit, type SearchOptions } from "./search";
export { BACKUP_FORMAT, exportBackup, importBackup, type AtlasBackup, type ImportReport } from "./backup";
export { ConversationLog, textHash, type CapturedMessage, type OrganizedMark } from "./conversations";
export { buildContext, describe, type ContextPack, type ContextRequest, type ObjectView } from "./context";
export { READING_LENSES, readingLensPrompt, readingLensTemplate, type ReadingLens } from "./reading-guide";
export { BOOK_CORE_TAGS, CLC_CLASSES, CLC_MAX_CODES, CLC_SCHEME, CLC_SECOND_LEVEL, CLC_VERSION, clcCandidates, clcClassOf, clcLabel, clcPrompt } from "./clc";
