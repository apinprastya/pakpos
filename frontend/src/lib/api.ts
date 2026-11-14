/**
 * The only module that talks to the generated Wails bindings. It converts
 * between binding types (TS enums, nullable slices) and `@/lib/model`.
 * Tests mock this module globally (see src/test/setup.ts).
 */
import { Events } from "@wailsio/runtime";
import {
  AppService,
  EnvService,
  HistoryService,
  RequestService,
  SettingsService,
  WorkspaceService,
} from "../../bindings/pakpos/internal/service";
import type * as bs from "../../bindings/pakpos/internal/core/settings/models";
import { WorkspaceChanged } from "../../bindings/events";
import type * as bm from "../../bindings/pakpos/internal/core/model/models";
import type * as bp from "../../bindings/pakpos/internal/pipeline/models";
import type * as bf from "../../bindings/pakpos/internal/store/fsstore/models";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
  type BuildInfo,
  normalizeHistoryEntry,
  normalizeRequest,
  normalizeSendResult,
  normalizeTree,
  normalizeEnvironment,
  normalizeGlobals,
  normalizePreview,
  normalizeSecretsStatus,
  normalizeVariables,
  normalizeCollection,
  normalizeFolder,
  type CollectionSettings,
  type FolderSettings,
  type CollectionNode,
  type EnvRef,
  type Environment,
  type Globals,
  type ResolvePreview,
  type ScopeRef,
  type SecretRename,
  type SecretStatus,
  type SecretsStatus,
  type Variable,
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
const toScope = (scope: ScopeRef) => scope as unknown as bp.ScopeRef;
/** Drops the editor-only `origin` so only the file's fields reach Go. */
const toVars = (vars: Variable[]) =>
  vars.map(({ key, value, enabled, secret }) => ({
    key,
    value,
    enabled,
    secret,
  })) as unknown as bm.Variable[];
const toRenames = (renames: SecretRename[]) => renames as unknown as bp.SecretRename[];

export interface WorkspaceChange {
  workspaceId: string;
  problems: Problem[];
}

export const api = {
  async buildInfo(): Promise<BuildInfo> {
    return AppService.BuildInfo();
  },

  async getSettings(): Promise<AppSettings> {
    return normalizeSettings((await SettingsService.Get()) as Partial<AppSettings>, DEFAULT_SETTINGS);
  },
  async defaultSettings(): Promise<AppSettings> {
    return normalizeSettings((await SettingsService.Defaults()) as Partial<AppSettings>, DEFAULT_SETTINGS);
  },
  /** Validates, saves and applies settings in Go; rejects with Go's validation message. */
  async setSettings(next: AppSettings): Promise<AppSettings> {
    const saved = await SettingsService.Set(next as unknown as bs.Settings);
    return normalizeSettings(saved as Partial<AppSettings>, DEFAULT_SETTINGS);
  },

  /** Sends req. `parentId` is the collection or folder a draft belongs to, so it inherits ("" for none). */
  async send(sendId: string, req: Request, parentId: string): Promise<SendResult> {
    return normalizeSendResult(await RequestService.Send(sendId, toBinding(req), parentId));
  },
  async cancel(sendId: string): Promise<boolean> {
    return RequestService.Cancel(sendId);
  },
  async save(req: Request): Promise<Request> {
    return normalizeRequest(await RequestService.Save(toBinding(req)));
  },
  /** Saves req as a new request at the end of a collection or folder. */
  async saveAs(parentId: string, name: string, req: Request): Promise<Request> {
    return normalizeRequest(await RequestService.SaveAs(parentId, name, toBinding(req)));
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
  /** Moves a request into a collection or folder at `index` among its children (-1 appends). */
  async moveRequest(id: string, toParentId: string, index: number): Promise<Request> {
    return normalizeRequest(await WorkspaceService.MoveRequest(id, toParentId, index));
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
  async createFolder(parentId: string, name: string): Promise<{ id: string; name: string }> {
    const f = await WorkspaceService.CreateFolder(parentId, name);
    return { id: f.id, name: f.name };
  },
  async renameFolder(id: string, name: string): Promise<void> {
    await WorkspaceService.RenameFolder(id, name);
  },
  async deleteFolder(id: string): Promise<void> {
    return WorkspaceService.DeleteFolder(id);
  },
  /** Moves a folder into a collection or another folder at `index` among its children. */
  async moveFolder(id: string, toParentId: string, index: number): Promise<void> {
    await WorkspaceService.MoveFolder(id, toParentId, index);
  },
  /** Sets the order of the folders and requests inside a collection or folder. */
  async reorder(parentId: string, ids: string[]): Promise<void> {
    return WorkspaceService.Reorder(parentId, ids);
  },
  async getCollection(id: string): Promise<CollectionSettings> {
    return normalizeCollection(await WorkspaceService.GetCollection(id));
  },
  /** Saves a collection's auth, headers and variables (secret values are never written). */
  /** `renames` lists renamed secret variables, so Go moves their stored values (a locked store refuses). */
  async saveCollection(
    id: string,
    settings: Pick<CollectionSettings, "auth" | "headers" | "variables">,
    renames: SecretRename[] = [],
  ): Promise<CollectionSettings> {
    const body = { auth: settings.auth, headers: settings.headers, variables: toVars(settings.variables) };
    return normalizeCollection(
      await WorkspaceService.SaveCollection(id, body as unknown as bf.CollectionSettings, toRenames(renames)),
    );
  },
  async getFolder(id: string): Promise<FolderSettings> {
    return normalizeFolder(await WorkspaceService.GetFolder(id));
  },
  async saveFolder(id: string, settings: Pick<FolderSettings, "auth" | "headers">): Promise<FolderSettings> {
    return normalizeFolder(await WorkspaceService.SaveFolder(id, settings as unknown as bf.FolderSettings));
  },
  /** Subscribes to external workspace changes; returns the unsubscribe function. */
  onWorkspaceChanged(cb: (change: WorkspaceChange) => void): () => void {
    return Events.On(WorkspaceChanged, (ev) => {
      cb({ workspaceId: ev.data.workspaceId, problems: ev.data.problems ?? [] });
    });
  },

  /** Lists the open workspace's history (or entries sent without one). */
  async historyList(filter: HistoryFilter): Promise<HistoryPage> {
    const page = await HistoryService.List({ ...filter, workspaceId: "", noWorkspace: false });
    return {
      items: (page.items ?? []).map((i) => ({ ...i, environmentName: i.environmentName ?? "" })),
      total: page.total,
    };
  },
  async historyGet(id: number): Promise<HistoryEntry> {
    return normalizeHistoryEntry(await HistoryService.Get(id));
  },
  async historyDelete(id: number): Promise<void> {
    return HistoryService.Delete(id);
  },
  /** Clears the open workspace's history (or entries sent without one). */
  async historyClear(): Promise<void> {
    return HistoryService.Clear();
  },

  async listEnvironments(): Promise<Environment[]> {
    return ((await EnvService.List()) ?? []).map(normalizeEnvironment);
  },
  async getEnvironment(id: string): Promise<Environment> {
    return normalizeEnvironment(await EnvService.Get(id));
  },
  async createEnvironment(name: string): Promise<Environment> {
    return normalizeEnvironment(await EnvService.Create(name));
  },
  async renameEnvironment(id: string, name: string): Promise<Environment> {
    return normalizeEnvironment(await EnvService.Rename(id, name));
  },
  /** Copies an environment, including its secret values on this machine. */
  async duplicateEnvironment(id: string): Promise<Environment> {
    return normalizeEnvironment(await EnvService.Duplicate(id));
  },
  /** Deletes an environment and its secret values. */
  async deleteEnvironment(id: string): Promise<void> {
    return EnvService.Delete(id);
  },
  async reorderEnvironments(ids: string[]): Promise<void> {
    return EnvService.Reorder(ids);
  },
  async getGlobals(): Promise<Globals> {
    return normalizeGlobals(await EnvService.Globals());
  },
  async saveGlobals(vars: Variable[], renames: SecretRename[] = []): Promise<Globals> {
    return normalizeGlobals(await EnvService.SaveGlobals(toVars(vars), toRenames(renames)));
  },
  /**
   * Saves the variables of the globals, a collection or an environment; returns them as saved.
   * `renames` lists renamed secret variables, so Go moves their stored values (a locked store refuses).
   */
  async saveVariables(scope: ScopeRef, vars: Variable[], renames: SecretRename[] = []): Promise<Variable[]> {
    return normalizeVariables(
      await EnvService.SaveVariables(toScope(scope), toVars(vars), toRenames(renames)),
    );
  },
  async setSecret(scope: ScopeRef, key: string, value: string): Promise<void> {
    return EnvService.SetSecret(toScope(scope), key, value);
  },
  async clearSecret(scope: ScopeRef, key: string): Promise<void> {
    return EnvService.ClearSecret(toScope(scope), key);
  },
  /** Which secret variables of a scope have a value on this machine (never the values). */
  async secretStatus(scope: ScopeRef): Promise<SecretStatus> {
    const s = await EnvService.SecretStatus(toScope(scope));
    return { set: s.set ?? [], locked: s.locked };
  },
  /** Returns one secret value. Call it only when the user clicks to reveal; never store the result. */
  async revealSecret(scope: ScopeRef, key: string): Promise<string> {
    return EnvService.RevealSecret(toScope(scope), key);
  },
  /** Turns a saved secret into a plain variable (its value is written to the file in Go). */
  async makeVariablePlain(scope: ScopeRef, key: string): Promise<Variable[]> {
    return normalizeVariables(await EnvService.MakeVariablePlain(toScope(scope), key));
  },
  /** Selects an environment for the open workspace ("" for none). */
  async selectEnvironment(id: string): Promise<void> {
    return EnvService.Select(id);
  },
  async selectedEnvironment(): Promise<EnvRef | null> {
    const e = await EnvService.Selected();
    return e ? { id: e.id, name: e.name } : null;
  },
  async resolvePreview(req: Request, parentId: string): Promise<ResolvePreview> {
    return normalizePreview(await EnvService.ResolvePreview(toBinding(req), parentId));
  },
  async secretsStatus(): Promise<SecretsStatus> {
    return normalizeSecretsStatus(await EnvService.SecretsStatus());
  },
  async setMasterPassword(password: string): Promise<void> {
    return EnvService.SetMasterPassword(password);
  },
  async changeMasterPassword(current: string, next: string): Promise<void> {
    return EnvService.ChangeMasterPassword(current, next);
  },
  /** Rejects with "Wrong password, or the secrets file is damaged." on a wrong password. */
  async unlockSecrets(password: string): Promise<void> {
    return EnvService.Unlock(password);
  },
  async lockSecrets(): Promise<void> {
    return EnvService.Lock();
  },
  /** Deletes every stored secret value (forgotten password or damaged file). */
  async resetSecretStore(): Promise<void> {
    return EnvService.ResetSecretStore();
  },
};

export type Api = typeof api;
