/**
 * The only module that talks to the generated Wails bindings. It converts
 * between binding types (TS enums, nullable slices) and `@/lib/model`.
 * Tests mock this module globally (see src/test/setup.ts).
 */
import { Events } from "@wailsio/runtime";
import {
  AppService,
  HistoryService,
  RequestService,
  WorkspaceService,
} from "../../bindings/pakpos/internal/service";
import { WorkspaceChanged } from "../../bindings/events";
import type * as bm from "../../bindings/pakpos/internal/core/model/models";
import {
  normalizeHistoryEntry,
  normalizeRequest,
  normalizeSendResult,
  normalizeTree,
  type CollectionNode,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryPage,
  type Problem,
  type RecentWorkspace,
  type Request,
  type SendResult,
  type WorkspaceInfo,
  type WorkspaceTree,
} from "./model";

const toBinding = (req: Request) => req as unknown as bm.Request;

export interface WorkspaceChange {
  workspaceId: string;
  problems: Problem[];
}

export const api = {
  async buildInfo(): Promise<{ version: string }> {
    return AppService.BuildInfo();
  },

  async send(sendId: string, req: Request): Promise<SendResult> {
    return normalizeSendResult(await RequestService.Send(sendId, toBinding(req)));
  },
  async cancel(sendId: string): Promise<boolean> {
    return RequestService.Cancel(sendId);
  },
  async save(req: Request): Promise<Request> {
    return normalizeRequest(await RequestService.Save(toBinding(req)));
  },
  async saveAs(collectionId: string, name: string, req: Request): Promise<Request> {
    return normalizeRequest(await RequestService.SaveAs(collectionId, name, toBinding(req)));
  },
  async pickFile(): Promise<string> {
    return RequestService.PickFile();
  },
  async saveResponseBody(historyId: number): Promise<string> {
    return RequestService.SaveResponseBody(historyId);
  },
  async getRequest(id: string): Promise<Request> {
    return normalizeRequest(await RequestService.Get(id));
  },
  async renameRequest(id: string, name: string): Promise<Request> {
    return normalizeRequest(await RequestService.Rename(id, name));
  },
  async duplicateRequest(id: string): Promise<Request> {
    return normalizeRequest(await RequestService.Duplicate(id));
  },
  async deleteRequest(id: string): Promise<void> {
    return RequestService.Delete(id);
  },
  async moveRequest(id: string, toCollectionId: string): Promise<Request> {
    return normalizeRequest(await RequestService.Move(id, toCollectionId));
  },
  async reorderRequests(collectionId: string, ids: string[]): Promise<void> {
    return RequestService.Reorder(collectionId, ids);
  },

  async currentWorkspace(): Promise<WorkspaceInfo | null> {
    return WorkspaceService.Current();
  },
  async pickFolder(): Promise<string> {
    return WorkspaceService.PickFolder();
  },
  async openWorkspace(path: string): Promise<WorkspaceInfo> {
    return WorkspaceService.Open(path);
  },
  async createWorkspace(path: string, name: string): Promise<WorkspaceInfo> {
    return WorkspaceService.Create(path, name);
  },
  async closeWorkspace(): Promise<void> {
    return WorkspaceService.Close();
  },
  async recentWorkspaces(): Promise<RecentWorkspace[]> {
    return (await WorkspaceService.Recent()) ?? [];
  },
  async removeRecent(path: string): Promise<void> {
    return WorkspaceService.RemoveRecent(path);
  },
  async tree(): Promise<WorkspaceTree> {
    return normalizeTree(await WorkspaceService.Tree());
  },
  async collections(): Promise<CollectionNode[]> {
    return (await api.tree()).collections;
  },
  async createCollection(name: string): Promise<{ id: string; name: string }> {
    const c = await WorkspaceService.CreateCollection(name);
    return { id: c.id, name: c.name };
  },
  async renameCollection(id: string, name: string): Promise<void> {
    await WorkspaceService.RenameCollection(id, name);
  },
  async deleteCollection(id: string): Promise<void> {
    return WorkspaceService.DeleteCollection(id);
  },
  async reorderCollections(ids: string[]): Promise<void> {
    return WorkspaceService.ReorderCollections(ids);
  },
  /** Subscribes to external workspace changes; returns the unsubscribe function. */
  onWorkspaceChanged(cb: (change: WorkspaceChange) => void): () => void {
    return Events.On(WorkspaceChanged, (ev) => {
      cb({ workspaceId: ev.data.workspaceId, problems: ev.data.problems ?? [] });
    });
  },

  async historyList(filter: HistoryFilter): Promise<HistoryPage> {
    const page = await HistoryService.List(filter);
    return { items: page.items ?? [], total: page.total };
  },
  async historyGet(id: number): Promise<HistoryEntry> {
    return normalizeHistoryEntry(await HistoryService.Get(id));
  },
  async historyDelete(id: number): Promise<void> {
    return HistoryService.Delete(id);
  },
  async historyClear(): Promise<void> {
    return HistoryService.Clear();
  },
};

export type Api = typeof api;
