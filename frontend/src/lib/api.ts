/**
 * The only module that talks to the generated Wails bindings. It converts
 * between binding types (TS enums, nullable slices) and `@/lib/model`.
 * Tests mock this module globally (see src/test/setup.ts).
 */
import { Events } from "@wailsio/runtime";
import {
  AppService,
  CookieService,
  EnvService,
  ExampleService,
  HistoryService,
  RequestService,
  RunnerService,
  SettingsService,
  UIStateService,
  UpdateService,
  WorkspaceService,
} from "../../bindings/pakpos/internal/service";
import type * as bs from "../../bindings/pakpos/internal/core/settings/models";
import type * as bc from "../../bindings/pakpos/internal/core/cookies/models";
import {
  RunnerProgress,
  ScriptConsole,
  UpdateProgress as UpdateProgressEvent,
  WorkspaceChanged,
} from "../../bindings/events";
import type * as bm from "../../bindings/pakpos/internal/core/model/models";
import type * as bp from "../../bindings/pakpos/internal/pipeline/models";
import type * as bf from "../../bindings/pakpos/internal/store/fsstore/models";
import type * as bsvc from "../../bindings/pakpos/internal/service/models";
import {
  normalizeDataPreview,
  normalizeRunEvent,
  normalizeRunListItem,
  normalizeRunReport,
  type DataPreview,
  type ExportFormat,
  type RunConfig,
  type RunListItem,
  type RunProgress,
  type RunReport,
} from "./runModel";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeStoredCookie,
  type CookieRef,
  type NetworkSecretStatus,
  type StoredCookie,
  type AppSettings,
  type BuildInfo,
  type UpdateInfo,
  type UpdateProgress,
  normalizeHistoryEntry,
  normalizeRequest,
  normalizeSendResult,
  normalizeTree,
  normalizeEnvironment,
  normalizeGlobals,
  normalizePreview,
  normalizeVisible,
  normalizeConsoleEntry,
  normalizeOverlayValue,
  type OverlayValue,
  type ScriptConsoleEvent,
  type Scripts,
  normalizeSecretsStatus,
  normalizeVariables,
  normalizeCollection,
  normalizeFolder,
  normalizeCodeResult,
  normalizeCurlImport,
  normalizeExample,
  normalizeExampleSummary,
  normalizeSaveExampleResult,
  type SaveExampleResult,
  type Example,
  type ExampleSummary,
  type CodeLanguage,
  type CodeOptions,
  type CodeResult,
  type CurlImport,
  type CollectionSettings,
  type FolderSettings,
  type CollectionNode,
  type EnvRef,
  type Environment,
  type Globals,
  type ResolvePreview,
  type VisibleVariables,
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

  /** Asks GitHub for the latest stable release. */
  async checkForUpdates(): Promise<UpdateInfo> {
    const info = await UpdateService.Check();
    if (!info) throw new Error("No update information was returned");
    return info;
  },
  /** Downloads, verifies and installs the release found by the last check. */
  async installUpdate(): Promise<void> {
    await UpdateService.Install();
  },
  async cancelUpdate(): Promise<boolean> {
    return UpdateService.Cancel();
  },
  /** Starts the installed update and quits this instance. */
  async restartToUpdate(): Promise<void> {
    await UpdateService.Restart();
  },
  async openReleasePage(): Promise<void> {
    await UpdateService.OpenReleasePage();
  },
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void {
    return Events.On(UpdateProgressEvent, (ev) => cb({ done: ev.data.done, total: ev.data.total }));
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

  /** Which network passwords are stored (never the values). */
  async networkSecretStatus(): Promise<NetworkSecretStatus> {
    const st = await SettingsService.NetworkSecretStatus();
    return {
      locked: st?.locked ?? false,
      proxyPassword: st?.proxyPassword ?? false,
      certPassphrases: st?.certPassphrases ?? [],
    };
  },
  /** Stores the proxy password in the secret store; "" deletes it. */
  async setProxyPassword(password: string): Promise<void> {
    return SettingsService.SetProxyPassword(password);
  },
  /** Stores a saved client certificate's PKCS#12 passphrase; "" deletes it. */
  async setCertPassphrase(id: string, passphrase: string): Promise<void> {
    return SettingsService.SetCertPassphrase(id, passphrase);
  },

  /** Cookies of the open workspace, by domain, path and name. */
  async listCookies(): Promise<StoredCookie[]> {
    return ((await CookieService.List()) ?? []).map(normalizeStoredCookie);
  },
  /** Rejects with a message for the user when the cookie isn't valid. */
  async addCookie(c: StoredCookie): Promise<StoredCookie> {
    return normalizeStoredCookie(await CookieService.Add(c as bc.Cookie));
  },
  async updateCookie(old: CookieRef, c: StoredCookie): Promise<StoredCookie> {
    return normalizeStoredCookie(await CookieService.Update(old, c as bc.Cookie));
  },
  async deleteCookie(ref: CookieRef): Promise<void> {
    return CookieService.Delete(ref);
  },
  async clearCookieDomain(domain: string): Promise<number> {
    return CookieService.ClearDomain(domain);
  },
  async clearAllCookies(): Promise<void> {
    return CookieService.ClearAll();
  },

  /** App-wide UI state (panel sizes, column widths): JSON strings by key. */
  async getUiState(): Promise<Record<string, string>> {
    const raw = (await UIStateService.Get()) ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  },
  /** Stores a JSON value under key; "" removes it. */
  async setUiState(key: string, value: string): Promise<void> {
    await UIStateService.Set(key, value);
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
  /** Reads a curl command into a request; rejects with a message for the user when it can't. */
  async importCurl(text: string): Promise<CurlImport> {
    return normalizeCurlImport(await RequestService.ImportCurl(text));
  },
  /**
   * Writes the request as code (language "curl" for Copy as cURL). Inherits like `send`
   * (`parentId` for drafts) and uses the selected environment. Secrets stay `{{name}}`
   * unless `revealSecrets`; never keep a revealed result beyond the dialog showing it.
   */
  async generateCode(
    req: Request,
    parentId: string,
    language: string,
    opts: CodeOptions,
  ): Promise<CodeResult> {
    return normalizeCodeResult(await RequestService.GenerateCode(toBinding(req), parentId, language, opts));
  },
  async codeLanguages(): Promise<CodeLanguage[]> {
    return ((await RequestService.CodeLanguages()) ?? []).map((l) => ({
      id: l.id,
      label: l.label,
      editor: l.editor,
    }));
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
    settings: Pick<CollectionSettings, "auth" | "headers" | "variables"> & { scripts?: Scripts },
    renames: SecretRename[] = [],
  ): Promise<CollectionSettings> {
    // Without `scripts` Go keeps the collection's scripts as they are.
    const body = {
      auth: settings.auth,
      headers: settings.headers,
      variables: toVars(settings.variables),
      scripts: settings.scripts ?? null,
    };
    return normalizeCollection(
      await WorkspaceService.SaveCollection(id, body as unknown as bf.CollectionSettings, toRenames(renames)),
    );
  },
  async getFolder(id: string): Promise<FolderSettings> {
    return normalizeFolder(await WorkspaceService.GetFolder(id));
  },
  /** Without `scripts` Go keeps the folder's scripts as they are. */
  async saveFolder(
    id: string,
    settings: Pick<FolderSettings, "auth" | "headers"> & { scripts?: Scripts },
  ): Promise<FolderSettings> {
    const body = { auth: settings.auth, headers: settings.headers, scripts: settings.scripts ?? null };
    return normalizeFolder(await WorkspaceService.SaveFolder(id, body as unknown as bf.FolderSettings));
  },
  /** Subscribes to external workspace changes; returns the unsubscribe function. */
  onWorkspaceChanged(cb: (change: WorkspaceChange) => void): () => void {
    return Events.On(WorkspaceChanged, (ev) => {
      cb({ workspaceId: ev.data.workspaceId, problems: ev.data.problems ?? [] });
    });
  },

  /** Subscribes to script console output while sends run; returns the unsubscribe function. */
  onScriptConsole(cb: (ev: ScriptConsoleEvent) => void): () => void {
    return Events.On(ScriptConsole, (ev) => {
      cb({ sendId: ev.data.sendId, entries: (ev.data.entries ?? []).map(normalizeConsoleEntry) });
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
  /** Values scripts set on a scope this session (secret values are never returned). */
  async overlayValues(scope: ScopeRef): Promise<OverlayValue[]> {
    return ((await EnvService.OverlayValues(toScope(scope))) ?? []).map(normalizeOverlayValue);
  },
  /** Drops a script value so the file value applies again ("" drops all of the scope's). */
  async resetOverlay(scope: ScopeRef, key: string): Promise<void> {
    return EnvService.ResetOverlay(toScope(scope), key);
  },
  /** Writes a script value to the file (a secret's to the store) and drops it from the overlay. */
  async persistOverlay(scope: ScopeRef, key: string): Promise<Variable[]> {
    return normalizeVariables(await EnvService.PersistOverlay(toScope(scope), key));
  },
  async resolvePreview(req: Request, parentId: string): Promise<ResolvePreview> {
    return normalizePreview(await EnvService.ResolvePreview(toBinding(req), parentId));
  },
  /** Variables visible from a collection or folder ("" for none); environmentId "" means the selected one. */
  async visibleVariables(parentId: string, environmentId: string): Promise<VisibleVariables> {
    return normalizeVisible(await EnvService.VisibleVariables(parentId, environmentId));
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

  /** Every example in the open workspace (summaries, grouped by request). */
  async listAllExamples(): Promise<ExampleSummary[]> {
    return ((await ExampleService.ListAll()) ?? []).map(normalizeExampleSummary);
  },
  async getExample(requestId: string, id: string): Promise<Example> {
    return normalizeExample(await ExampleService.Get(requestId, id));
  },
  /**
   * Saves the response of a history entry as an example of a saved request.
   * Nothing is saved when it holds a secret's value (`secretsFound`) unless
   * `replaceSecrets`, which writes `{{name}}` instead, or when the secret
   * store is locked (`secretsLocked`). Rejects with a message for the user
   * (e.g. a body over 1 MB).
   */
  async saveExample(
    requestId: string,
    name: string,
    historyId: number,
    replaceSecrets = false,
  ): Promise<SaveExampleResult> {
    return normalizeSaveExampleResult(await ExampleService.Save(requestId, name, historyId, replaceSecrets));
  },
  async renameExample(requestId: string, id: string, name: string): Promise<ExampleSummary> {
    return normalizeExampleSummary(await ExampleService.Rename(requestId, id, name));
  },
  async deleteExample(requestId: string, id: string): Promise<void> {
    return ExampleService.Delete(requestId, id);
  },

  /** Starts a collection or folder run in the open workspace; resolves with its id. */
  async startRun(config: RunConfig): Promise<string> {
    return RunnerService.Start(config as bsvc.RunConfig);
  },
  async cancelRun(runId: string): Promise<boolean> {
    return RunnerService.Cancel(runId);
  },
  /** The open workspace's stored runs, newest first. */
  async listRuns(): Promise<RunListItem[]> {
    return ((await RunnerService.List()) ?? []).map(normalizeRunListItem);
  },
  async getRun(runId: string): Promise<RunReport> {
    return normalizeRunReport(await RunnerService.Get(runId));
  },
  async deleteRun(runId: string): Promise<void> {
    return RunnerService.Delete(runId);
  },
  /** Asks where to save the report; resolves with the path, or "" when cancelled. */
  async exportRun(runId: string, format: ExportFormat): Promise<string> {
    return RunnerService.Export(runId, format);
  },
  /** Asks for a CSV or JSON data file; "" when cancelled. */
  async pickDataFile(): Promise<string> {
    return RunnerService.PickDataFile();
  },
  async previewData(path: string): Promise<DataPreview> {
    return normalizeDataPreview(await RunnerService.PreviewData(path));
  },
  /** Subscribes to runner progress; returns the unsubscribe function. */
  onRunnerProgress(cb: (p: RunProgress) => void): () => void {
    return Events.On(RunnerProgress, (ev) => {
      cb({ runId: ev.data.runId, workspaceId: ev.data.workspaceId, event: normalizeRunEvent(ev.data.event) });
    });
  },
};

export type Api = typeof api;
