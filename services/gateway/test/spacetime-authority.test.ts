import { describe, expect, it } from "vitest";
import type { VerifiedBearerProvenance } from "../src/auth/oidc.js";
import type { Principal, VerifiedIdentity } from "../src/contracts.js";
import {
  type GatewaySpacetimeConnector,
  type GatewaySpacetimeTransport,
  SpacetimeGatewayAuthority,
} from "../src/production/spacetime-authority.js";

const identity: VerifiedIdentity = Object.freeze({
  issuer: "https://issuer.test",
  subject: "workos-user",
  issuedAt: 1_700_000_000,
  expiresAt: 4_000_000_000,
  tokenType: "access",
});
const principalIdentity = "11".repeat(32);
const workspaceId = "018f1000-0000-7000-8000-000000000001";
const spaceId = "018f1000-0000-7000-8000-000000000002";
const uploadId = "018f1000-0000-7000-8000-000000000003";
const fileId = "018f1000-0000-7000-8000-000000000004";
const bearer = `header.${Buffer.from(
  JSON.stringify({ aud: ["gateway", "spacetimedb"], exp: identity.expiresAt }),
).toString("base64url")}.signature`;

class MockTransport implements GatewaySpacetimeTransport {
  readonly connectionIdentity = principalIdentity;
  connected = true;
  readonly data: Record<string, Record<string, unknown>[]> = {
    currentGatewayPrincipal: [{ identity: principalIdentity, authzEpoch: 7n, disabled: false }],
    myGatewayWorkspaceGrants: [
      {
        workspaceId,
        membershipEpoch: 3n,
        userAuthzEpoch: 7n,
        canRead: true,
        canWrite: true,
        canManageMembers: false,
        canManageWorkspace: false,
        canManageAgents: false,
        canRunAgents: true,
      },
    ],
    myGatewaySpaceGrants: [
      {
        workspaceId,
        spaceId,
        membershipEpoch: 3n,
        canRead: true,
        canWrite: true,
        canRunAgents: true,
      },
    ],
    myGatewayFileDescriptors: [],
    myGatewayPendingUploads: [],
    visibleDirectParticipants: [
      {
        key: "dm-membership-key",
        conversationId: "018f1000-0000-7000-8000-000000000005",
        workspaceId,
        leftAt: null,
      },
    ],
  };
  readonly reductions: { accessor: string; input: Readonly<Record<string, unknown>> }[] = [];

  rows(accessor: string): readonly Readonly<Record<string, unknown>>[] {
    return this.data[accessor] ?? [];
  }

  async reduce(accessor: string, input: Readonly<Record<string, unknown>>): Promise<void> {
    this.reductions.push({ accessor, input });
    if (accessor === "createFileUpload") {
      this.data.myGatewayPendingUploads?.push({
        uploadId,
        fileId,
        workspaceId,
        spaceId,
        uploaderIdentity: principalIdentity,
        sourceKey: `uploads/${workspaceId}/${fileId}/1`,
        fileName: "report.txt",
        declaredType: "text/plain",
        declaredSizeBytes: 5n,
        checksumSha256: "a".repeat(64),
        expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 60_000) * 1_000n },
        completed: false,
        fileState: { tag: "UploadPending" },
        fileRevision: 1n,
      });
    }
    if (accessor === "completeFileUpload") {
      const row = this.data.myGatewayPendingUploads?.[0];
      if (row) row.completed = true;
    }
  }

  close(): void {
    this.connected = false;
  }
}

function fixture() {
  const transport = new MockTransport();
  const connector: GatewaySpacetimeConnector = {
    connect: async (input) => {
      expect(input.bearerToken).toBe(bearer);
      return transport;
    },
  };
  const bearers: VerifiedBearerProvenance = {
    bearerFor: (candidate) => (candidate === identity ? bearer : undefined),
  };
  const authority = new SpacetimeGatewayAuthority(
    {
      uri: "ws://127.0.0.1:3001",
      databaseName: "parrot-staging",
      connectTimeoutMs: 1_000,
      commandTimeoutMs: 500,
      idleTimeoutMs: 10_000,
    },
    bearers,
    connector,
  );
  return { authority, transport };
}

async function checkedPrincipal(authority: SpacetimeGatewayAuthority): Promise<Principal> {
  const resolved = await authority.resolve(identity);
  const checked: Principal = Object.freeze({ ...resolved });
  authority.bindCheckedPrincipal({ identity, resolved, checked });
  return checked;
}

describe("SpacetimeGatewayAuthority", () => {
  it("binds only the exact attested identity and enforces current grant epochs", async () => {
    const { authority, transport } = fixture();
    await expect(authority.resolve({ ...identity })).rejects.toMatchObject({ statusCode: 401 });
    const principal = await checkedPrincipal(authority);
    await expect(
      authority.authorize({
        principal,
        action: "database:connect",
        resource: { workspaceId, kind: "workspace", id: workspaceId },
      }),
    ).resolves.toBe(true);
    await expect(
      authority.mint({
        principal,
        workspaceId,
        audience: "spacetimedb",
        authzEpoch: 7,
        ttlSeconds: 120,
      }),
    ).resolves.toEqual({
      token: bearer,
      expiresAt: new Date(identity.expiresAt * 1_000).toISOString(),
    });
    await expect(
      authority.mint({
        principal,
        workspaceId,
        audience: "unbound-audience",
        authzEpoch: 7,
        ttlSeconds: 120,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      authority.authorize({
        principal,
        action: "invitation:create",
        resource: { workspaceId, kind: "workspace", id: workspaceId },
      }),
    ).resolves.toBe(false);
    await expect(
      authority.authorize({
        principal,
        action: "file:upload",
        resource: { workspaceId, kind: "space", id: spaceId },
      }),
    ).resolves.toBe(true);
    const scope = await authority.searchScope(principal, workspaceId);
    expect(scope).toEqual({
      workspaceId,
      spaceIds: [spaceId],
      dmMembershipKeys: ["dm-membership-key"],
      authzEpoch: 7,
    });
    const row = transport.data.currentGatewayPrincipal?.[0];
    if (row) row.authzEpoch = 8n;
    await expect(
      authority.authorize({
        principal,
        action: "database:connect",
        resource: { workspaceId, kind: "workspace", id: workspaceId },
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("uses authoritative upload rows and observes reducer commits", async () => {
    const { authority, transport } = fixture();
    const principal = await checkedPrincipal(authority);
    const pending = await authority.createPending({
      principal,
      reservationId: uploadId,
      workspaceId,
      spaceId,
      displayName: "report.txt",
      declaredContentType: "text/plain",
      expectedBytes: 5,
      checksumSha256: "a".repeat(64),
      maximumExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(pending).toMatchObject({
      id: uploadId,
      workspaceId,
      spaceId,
      objectKey: `uploads/${workspaceId}/${fileId}/1`,
      uploaderId: principalIdentity,
      lifecycle: "pending",
    });
    expect(transport.reductions[0]).toMatchObject({ accessor: "createFileUpload" });
    await authority.markQuarantined(principal, uploadId, {
      sizeBytes: 5,
      contentType: "text/plain",
      objectVersion: "immutable-version",
      checksumSha256: "a".repeat(64),
    });
    expect((await authority.getPending(principal, uploadId))?.lifecycle).toBe("quarantined");
    expect(transport.reductions[1]).toMatchObject({ accessor: "completeFileUpload" });
  });

  it("exposes only caller-visible clean immutable files", async () => {
    const { authority, transport } = fixture();
    const principal = await checkedPrincipal(authority);
    transport.data.myGatewayFileDescriptors?.push({
      fileId,
      workspaceId,
      spaceId,
      ownerIdentity: principalIdentity,
      fileName: "clean.txt",
      objectKey: `clean/${workspaceId}/${fileId}/1`,
      objectVersion: "version-1",
      checksumSha256: "b".repeat(64),
      detectedType: "text/plain",
      sizeBytes: 10n,
      state: { tag: "Clean" },
      revision: 4n,
    });
    await expect(authority.getFile(principal, fileId)).resolves.toMatchObject({
      id: fileId,
      lifecycle: "clean",
      immutable: true,
      objectVersion: "version-1",
    });
    await expect(
      authority.authorize({
        principal,
        action: "file:download",
        resource: { workspaceId, kind: "file", id: fileId, spaceId },
      }),
    ).resolves.toBe(true);
  });
});
