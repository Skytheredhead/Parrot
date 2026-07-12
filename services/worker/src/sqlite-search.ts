import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchBackend, SearchDocument, SearchVersion } from "./adapters.js";
import { searchContentHash } from "./adapters.js";

const ID = /^[A-Za-z0-9._:-]{1,256}$/;

/** Durable local FTS5 index. ACL filtering remains mandatory at the query boundary. */
export class SqliteFtsSearchBackend implements SearchBackend {
  readonly adapterKind = "durable" as const;
  readonly adapterName = "sqlite-fts5-search";
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("search_path_must_be_absolute");
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS search_documents(
        workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, resource_revision INTEGER NOT NULL,
        acl_revision INTEGER NOT NULL, body TEXT NOT NULL, visibility_json TEXT NOT NULL,
        tombstone INTEGER NOT NULL, content_hash TEXT NOT NULL, generation INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, resource_id, generation));
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(workspace_id UNINDEXED, resource_id UNINDEXED, body, generation UNINDEXED, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS search_rebuilds(workspace_id TEXT PRIMARY KEY, rebuild_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_active(workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);`);
  }

  assertProductionReady(): boolean {
    return true;
  }
  async ready(): Promise<boolean> {
    try {
      this.db.prepare("SELECT count(*) AS n FROM search_fts").get();
      return true;
    } catch {
      return false;
    }
  }

  private normalize(document: SearchDocument): Required<SearchDocument> {
    if (
      !ID.test(document.workspaceId) ||
      !ID.test(document.resourceId) ||
      !Number.isSafeInteger(document.aclRevision) ||
      document.aclRevision < 0 ||
      !Number.isSafeInteger(document.resourceRevision) ||
      document.resourceRevision < 0 ||
      Buffer.byteLength(document.body, "utf8") > 5_000_000
    )
      throw new Error("search_document_invalid");
    const visibilityIds = [...new Set(document.visibilityIds)].sort();
    if (visibilityIds.length > 10_000 || visibilityIds.some((id) => !ID.test(id)))
      throw new Error("search_visibility_invalid");
    const normalized = {
      ...document,
      body: document.tombstone ? "" : document.body,
      visibilityIds,
    };
    const contentHash = searchContentHash(normalized);
    if (document.contentHash && document.contentHash !== contentHash)
      throw new Error("search_content_hash_mismatch");
    return { ...normalized, contentHash };
  }

  private active(workspaceId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT generation FROM search_active WHERE workspace_id=?")
          .get(workspaceId) as { generation?: number } | undefined
      )?.generation ?? 0,
    );
  }

  private put(input: SearchDocument, generation: number): void {
    const document = this.normalize(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT resource_revision,acl_revision FROM search_documents WHERE workspace_id=? AND resource_id=? AND generation=?",
        )
        .get(document.workspaceId, document.resourceId, generation) as
        | { resource_revision: number; acl_revision: number }
        | undefined;
      if (
        existing &&
        (existing.acl_revision > document.aclRevision ||
          (existing.acl_revision === document.aclRevision &&
            existing.resource_revision >= document.resourceRevision))
      ) {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare("DELETE FROM search_fts WHERE workspace_id=? AND resource_id=? AND generation=?")
        .run(document.workspaceId, document.resourceId, generation);
      this.db
        .prepare(
          `INSERT INTO search_documents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,resource_id,generation) DO UPDATE SET resource_revision=excluded.resource_revision,acl_revision=excluded.acl_revision,body=excluded.body,visibility_json=excluded.visibility_json,tombstone=excluded.tombstone,content_hash=excluded.content_hash`,
        )
        .run(
          document.workspaceId,
          document.resourceId,
          document.resourceRevision,
          document.aclRevision,
          document.body,
          JSON.stringify(document.visibilityIds),
          document.tombstone ? 1 : 0,
          document.contentHash,
          generation,
        );
      if (!document.tombstone)
        this.db
          .prepare(
            "INSERT INTO search_fts(workspace_id,resource_id,body,generation) VALUES(?,?,?,?)",
          )
          .run(document.workspaceId, document.resourceId, document.body, generation);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async apply(document: SearchDocument): Promise<void> {
    this.put(document, this.active(document.workspaceId));
  }
  async version(workspaceId: string, resourceId: string): Promise<SearchVersion | undefined> {
    const row = this.db
      .prepare(
        "SELECT resource_revision,acl_revision,tombstone,content_hash FROM search_documents WHERE workspace_id=? AND resource_id=? AND generation=?",
      )
      .get(workspaceId, resourceId, this.active(workspaceId)) as
      | { resource_revision: number; acl_revision: number; tombstone: number; content_hash: string }
      | undefined;
    return row
      ? {
          resourceRevision: row.resource_revision,
          aclRevision: row.acl_revision,
          tombstone: row.tombstone === 1,
          contentHash: row.content_hash,
        }
      : undefined;
  }
  async beginRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"started" | "existing" | "stale"> {
    if (
      !ID.test(workspaceId) ||
      !ID.test(rebuildId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new Error("search_rebuild_invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT rebuild_id,generation FROM search_rebuilds WHERE workspace_id=?")
        .get(workspaceId) as { rebuild_id: string; generation: number } | undefined;
      if (prior && prior.generation > generation) {
        this.db.exec("COMMIT");
        return "stale";
      }
      if (prior && prior.generation === generation && prior.rebuild_id === rebuildId) {
        this.db.exec("COMMIT");
        return "existing";
      }
      if (prior && prior.generation === generation)
        throw new Error("search_rebuild_generation_conflict");
      this.db
        .prepare(
          "INSERT INTO search_rebuilds VALUES(?,?,?,'building') ON CONFLICT(workspace_id) DO UPDATE SET rebuild_id=excluded.rebuild_id,generation=excluded.generation,state='building'",
        )
        .run(workspaceId, rebuildId, generation);
      this.db
        .prepare("DELETE FROM search_documents WHERE workspace_id=? AND generation=?")
        .run(workspaceId, generation);
      this.db
        .prepare("DELETE FROM search_fts WHERE workspace_id=? AND generation=?")
        .run(workspaceId, generation);
      this.db.exec("COMMIT");
      return "started";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async applyRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
    document: SearchDocument,
  ): Promise<void> {
    const row = this.db
      .prepare("SELECT rebuild_id,generation,state FROM search_rebuilds WHERE workspace_id=?")
      .get(workspaceId) as { rebuild_id: string; generation: number; state: string } | undefined;
    if (
      !row ||
      row.rebuild_id !== rebuildId ||
      row.generation !== generation ||
      row.state !== "building" ||
      document.workspaceId !== workspaceId
    )
      throw new Error("search_rebuild_not_current");
    this.put(document, generation);
  }
  async activateRebuild(
    workspaceId: string,
    rebuildId: string,
    generation: number,
  ): Promise<"activated" | "already_active" | "stale"> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.active(workspaceId) === generation) {
        this.db.exec("COMMIT");
        return "already_active";
      }
      const row = this.db
        .prepare("SELECT rebuild_id,generation,state FROM search_rebuilds WHERE workspace_id=?")
        .get(workspaceId) as { rebuild_id: string; generation: number; state: string } | undefined;
      if (
        !row ||
        row.rebuild_id !== rebuildId ||
        row.generation !== generation ||
        row.state !== "building"
      ) {
        this.db.exec("COMMIT");
        return "stale";
      }
      this.db
        .prepare(
          "INSERT INTO search_active VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET generation=excluded.generation",
        )
        .run(workspaceId, generation);
      this.db
        .prepare("UPDATE search_rebuilds SET state='active' WHERE workspace_id=?")
        .run(workspaceId);
      this.db.exec("COMMIT");
      return "activated";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async activeGeneration(workspaceId: string): Promise<number | undefined> {
    const value = this.active(workspaceId);
    return value === 0 ? undefined : value;
  }

  /** Query is intentionally ACL-scoped and never returns bodies. */
  query(
    workspaceId: string,
    principalIds: readonly string[],
    query: string,
    limit = 20,
  ): readonly string[] {
    if (
      !ID.test(workspaceId) ||
      principalIds.length === 0 ||
      principalIds.some((id) => !ID.test(id)) ||
      limit < 1 ||
      limit > 100 ||
      Buffer.byteLength(query, "utf8") > 1_000
    )
      throw new Error("search_query_invalid");
    const rows = this.db
      .prepare(
        `SELECT d.resource_id,d.visibility_json FROM search_fts f JOIN search_documents d ON d.workspace_id=f.workspace_id AND d.resource_id=f.resource_id AND d.generation=f.generation WHERE search_fts MATCH ? AND f.workspace_id=? AND f.generation=? LIMIT ?`,
      )
      .all(query, workspaceId, this.active(workspaceId), Math.min(limit * 10, 1_000)) as Array<{
      resource_id: string;
      visibility_json: string;
    }>;
    const principals = new Set(principalIds);
    return rows
      .filter((row) =>
        (JSON.parse(row.visibility_json) as string[]).some((id) => principals.has(id)),
      )
      .slice(0, limit)
      .map((row) => row.resource_id);
  }
}
