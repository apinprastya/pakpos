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
    collections: vi.fn().mockResolvedValue([]),
    createCollection: vi.fn(),
  };
}
