/**
 * The only module that talks to the generated Wails bindings. It converts
 * between binding types (TS enums, nullable slices) and `@/lib/model`.
 * Tests mock this module globally (see src/test/setup.ts).
 */
import { AppService, RequestService, WorkspaceService } from "../../bindings/pakpos/internal/service";
import type * as bm from "../../bindings/pakpos/internal/core/model/models";
import {
  normalizeRequest,
  normalizeSendResult,
  type CollectionNode,
  type Request,
  type SendResult,
  type WorkspaceInfo,
} from "./model";

const toBinding = (req: Request) => req as unknown as bm.Request;

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
  async collections(): Promise<CollectionNode[]> {
    const tree = await WorkspaceService.Tree();
    return (tree.collections ?? []).map((c) => ({ ...c, requests: c.requests ?? [] }));
  },
  async createCollection(name: string): Promise<{ id: string; name: string }> {
    const c = await WorkspaceService.CreateCollection(name);
    return { id: c.id, name: c.name };
  },
};

export type Api = typeof api;
