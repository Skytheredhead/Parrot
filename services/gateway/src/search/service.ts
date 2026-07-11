import { createHash } from "node:crypto";
import { resourceAuthorizationKey } from "../contracts.js";
import type {
  AuthorizationClient,
  Principal,
  SearchAdapter,
  SearchCandidate,
  SearchCursorBinding,
  SearchCursorCodec,
} from "../contracts.js";
import { forbidden, invalidInput, unavailable } from "../errors.js";
import type { WorkspaceBudget } from "../files/service.js";

export interface SafeSearchResult {
  items: readonly {
    kind: SearchCandidate["resource"]["kind"];
    id: string;
    workspaceId: string;
    title: string;
    snippet: string;
    occurredAt: string;
    source: SearchCandidate["source"];
  }[];
  nextCursor?: string;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("base64url");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const resourceKinds = new Set([
  "workspace",
  "space",
  "file",
  "message",
  "post",
  "task",
  "dm",
  "agent_run",
  "tool",
]);
const sources = new Set(["human", "agent", "service"]);

function assertCandidate(candidate: SearchCandidate): void {
  if (
    !safeId.test(candidate.resource.workspaceId) ||
    !safeId.test(candidate.resource.id) ||
    (candidate.resource.spaceId !== undefined && !safeId.test(candidate.resource.spaceId)) ||
    !resourceKinds.has(candidate.resource.kind) ||
    !sources.has(candidate.source) ||
    typeof candidate.title !== "string" ||
    typeof candidate.snippet !== "string" ||
    typeof candidate.occurredAt !== "string" ||
    Buffer.byteLength(candidate.occurredAt, "utf8") > 64 ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) {
    throw unavailable("Search adapter returned an invalid candidate");
  }
}

function resultBytes(value: SafeSearchResult): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class PermissionSafeSearchService {
  constructor(
    private readonly authorization: AuthorizationClient,
    private readonly search: SearchAdapter,
    private readonly cursors: SearchCursorCodec,
    private readonly budget: WorkspaceBudget,
    private readonly config: {
      cursorTtlSeconds: number;
      maxResponseBytes: number;
      maxTitleBytes: number;
      maxSnippetBytes: number;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async query(
    principal: Principal,
    input: { workspaceId: string; query: string; limit: number; cursor?: string },
  ): Promise<SafeSearchResult> {
    const query = input.query.trim();
    if (query.length < 2 || query.length > 500)
      throw invalidInput("Search query must be between 2 and 500 characters");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
      throw invalidInput("Invalid search limit");
    const canSearch = await this.authorization.authorize({
      principal,
      action: "search:query",
      resource: { workspaceId: input.workspaceId, kind: "workspace", id: input.workspaceId },
    });
    if (!canSearch) throw forbidden();
    const scope = await this.authorization.searchScope(principal, input.workspaceId);
    if (scope.workspaceId !== input.workspaceId || scope.authzEpoch !== principal.authzEpoch)
      throw forbidden("Search authorization is stale");
    const binding: SearchCursorBinding = {
      principalId: principal.id,
      workspaceId: input.workspaceId,
      queryHash: queryHash(query),
      authzEpoch: scope.authzEpoch,
    };
    let engineCursor = input.cursor
      ? await this.cursors.decode(input.cursor, binding, Math.floor(this.now().getTime() / 1_000))
      : undefined;
    if (engineCursor !== undefined && Buffer.byteLength(engineCursor, "utf8") > 1_024)
      throw invalidInput("Search cursor is too large");

    const visible: SearchCandidate[] = [];
    const seenCursors = new Set<string>();
    let nextEngineCursor: string | undefined;
    let pages = 0;
    let budgetExhausted = false;
    while (visible.length < input.limit && pages < 5) {
      if (engineCursor && seenCursors.has(engineCursor)) break;
      if (engineCursor) seenCursors.add(engineCursor);
      await this.budget.consume(principal, input.workspaceId, "search-page");
      const requestedLimit = input.limit - visible.length;
      const page = await this.search.candidates({
        query,
        scope,
        limit: requestedLimit,
        ...(engineCursor === undefined ? {} : { cursor: engineCursor }),
      });
      if (page.candidates.length > requestedLimit)
        throw unavailable("Search adapter exceeded the requested candidate limit");
      for (const candidate of page.candidates) assertCandidate(candidate);
      const scopedCandidates = page.candidates.filter(
        (candidate) => candidate.resource.workspaceId === input.workspaceId,
      );
      const authorizedIds = await this.authorization.authorizeMany(
        principal,
        "search:read_result",
        scopedCandidates.map((candidate) => candidate.resource),
      );
      for (const candidate of scopedCandidates) {
        if (!authorizedIds.has(resourceAuthorizationKey(candidate.resource))) continue;
        const boundedCandidate: SearchCandidate = {
          ...candidate,
          title: truncateUtf8(candidate.title, this.config.maxTitleBytes),
          snippet: truncateUtf8(candidate.snippet, this.config.maxSnippetBytes),
        };
        const prospectiveItems = [...visible, boundedCandidate].map((item) => ({
          kind: item.resource.kind,
          id: item.resource.id,
          workspaceId: item.resource.workspaceId,
          title: item.title,
          snippet: item.snippet,
          occurredAt: item.occurredAt,
          source: item.source,
        }));
        if (resultBytes({ items: prospectiveItems }) > this.config.maxResponseBytes) {
          budgetExhausted = true;
          break;
        }
        visible.push(boundedCandidate);
        if (visible.length === input.limit) break;
      }
      pages += 1;
      nextEngineCursor = page.nextCursor;
      if (
        nextEngineCursor !== undefined &&
        (nextEngineCursor.length === 0 || Buffer.byteLength(nextEngineCursor, "utf8") > 1_024)
      ) {
        throw unavailable("Search adapter returned an invalid cursor");
      }
      if (budgetExhausted || !nextEngineCursor || nextEngineCursor === engineCursor) break;
      engineCursor = nextEngineCursor;
    }

    let nextCursor =
      !budgetExhausted && visible.length === input.limit && nextEngineCursor
        ? await this.cursors.encode({
            ...binding,
            engineCursor: nextEngineCursor,
            expiresAt: Math.floor(this.now().getTime() / 1_000) + this.config.cursorTtlSeconds,
          })
        : undefined;
    if (nextCursor !== undefined && Buffer.byteLength(nextCursor, "utf8") > 2_048) {
      nextCursor = undefined;
    }
    const result: SafeSearchResult = {
      items: visible.map((candidate) => ({
        kind: candidate.resource.kind,
        id: candidate.resource.id,
        workspaceId: candidate.resource.workspaceId,
        title: candidate.title,
        snippet: candidate.snippet,
        occurredAt: candidate.occurredAt,
        source: candidate.source,
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    if (resultBytes(result) > this.config.maxResponseBytes) {
      throw unavailable("Search response exceeded the configured byte limit");
    }
    return result;
  }
}
