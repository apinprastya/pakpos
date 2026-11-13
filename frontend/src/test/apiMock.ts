import { vi } from "vitest";
import type { Api } from "@/lib/api";

/** Fresh vi.fn() stubs for every api method, with harmless defaults. */
export function createApiMock(): { [K in keyof Api]: ReturnType<typeof vi.fn> } {
  return {
    buildInfo: vi.fn().mockResolvedValue({ version: "test" }),
    send: vi.fn().mockResolvedValue({ response: null, error: null, historyId: 0 }),
    cancel: vi.fn().mockResolvedValue(true),
    save: vi.fn(async (r) => r),
    saveAs: vi.fn(async (_c, name, r) => ({ ...r, id: "saved-id", name })),
    pickFile: vi.fn().mockResolvedValue(""),
    saveResponseBody: vi.fn().mockResolvedValue(""),
    currentWorkspace: vi.fn().mockResolvedValue(null),
    pickFolder: vi.fn().mockResolvedValue(""),
    openWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    closeWorkspace: vi.fn().mockResolvedValue(undefined),
    recentWorkspaces: vi.fn().mockResolvedValue([]),
    removeRecent: vi.fn().mockResolvedValue(undefined),
    tree: vi.fn().mockResolvedValue({ collections: [], problems: [] }),
    collections: vi.fn().mockResolvedValue([]),
    createCollection: vi.fn(),
    renameCollection: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    reorderCollections: vi.fn().mockResolvedValue(undefined),
    onWorkspaceChanged: vi.fn().mockReturnValue(() => {}),
    getRequest: vi.fn(),
    renameRequest: vi.fn(),
    duplicateRequest: vi.fn(),
    deleteRequest: vi.fn().mockResolvedValue(undefined),
    moveRequest: vi.fn(),
    reorderRequests: vi.fn().mockResolvedValue(undefined),
    historyList: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    historyGet: vi.fn(),
    historyDelete: vi.fn().mockResolvedValue(undefined),
    historyClear: vi.fn().mockResolvedValue(undefined),
  };
}
