import { create } from "zustand";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { Auth, OAuth2Status } from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";

/**
 * OAuth 2.0 tokens per owner (the request, folder or collection id whose auth
 * got them). Go keeps the tokens in the secret store; this store only holds
 * their status, the running browser flow and the last error. Token values are
 * never kept here (Reveal returns one for the caller to show).
 */
interface Flow {
  flowId: string;
  /** The authorization URL opened in the browser, once Go reports it. */
  authUrl: string;
}

interface OAuth2State {
  statuses: Record<string, OAuth2Status>;
  flows: Record<string, Flow>;
  /** Last error per owner ("" or missing for none). */
  errors: Record<string, string>;
  /** An action other than a flow is running for the owner. */
  busy: Record<string, boolean>;

  load: (ownerId: string) => Promise<void>;
  /** Gets a new token; resolves true when one was stored. */
  start: (ownerId: string, parentId: string, auth: Auth) => Promise<boolean>;
  cancel: (ownerId: string) => Promise<void>;
  refresh: (ownerId: string, parentId: string, auth: Auth) => Promise<void>;
  clear: (ownerId: string) => Promise<void>;
  /** The access token, or null when it couldn't be read (the error is kept). */
  reveal: (ownerId: string) => Promise<string | null>;
}

export const oauth2Initial = {
  statuses: {} as Record<string, OAuth2Status>,
  flows: {} as Record<string, Flow>,
  errors: {} as Record<string, string>,
  busy: {} as Record<string, boolean>,
};

let flowSeq = 0;

export const useOAuth2Store = create<OAuth2State>()((set, get) => {
  const put = <K extends "statuses" | "flows" | "errors" | "busy">(
    key: K,
    ownerId: string,
    value: OAuth2State[K][string] | undefined,
  ) =>
    set((s) => {
      const next = { ...s[key] } as Record<string, unknown>;
      if (value === undefined) delete next[ownerId];
      else next[ownerId] = value;
      return { [key]: next } as Partial<OAuth2State>;
    });

  /** Runs a secret-store action after the store is ready; false when the user backed out. */
  const ready = () => useSecretsStore.getState().ensureReady();

  return {
    ...oauth2Initial,

    load: async (ownerId) => {
      if (!ownerId) return;
      try {
        put("statuses", ownerId, await api.oauth2TokenStatus(ownerId));
      } catch (e) {
        put("errors", ownerId, errorMessage(e));
      }
    },

    start: async (ownerId, parentId, auth) => {
      if (get().flows[ownerId] || !(await ready())) return false;
      const flowId = `oauth2-${Date.now()}-${++flowSeq}`;
      put("errors", ownerId, undefined);
      put("flows", ownerId, { flowId, authUrl: "" });
      const off = api.onOAuth2Flow((ev) => {
        if (ev.flowId === flowId && get().flows[ownerId]?.flowId === flowId) {
          put("flows", ownerId, { flowId, authUrl: ev.authUrl });
        }
      });
      try {
        put("statuses", ownerId, await api.startOAuth2(flowId, ownerId, parentId, auth));
        return true;
      } catch (e) {
        const msg = errorMessage(e);
        if (msg !== "Cancelled.") put("errors", ownerId, msg);
        return false;
      } finally {
        off();
        put("flows", ownerId, undefined);
      }
    },

    cancel: async (ownerId) => {
      const flow = get().flows[ownerId];
      if (flow) await api.cancelOAuth2(flow.flowId);
    },

    refresh: async (ownerId, parentId, auth) => {
      if (!(await ready())) return;
      put("busy", ownerId, true);
      put("errors", ownerId, undefined);
      try {
        put("statuses", ownerId, await api.refreshOAuth2(ownerId, parentId, auth));
      } catch (e) {
        put("errors", ownerId, errorMessage(e));
      } finally {
        put("busy", ownerId, undefined);
      }
    },

    clear: async (ownerId) => {
      if (!(await ready())) return;
      put("errors", ownerId, undefined);
      try {
        await api.clearOAuth2Token(ownerId);
        await get().load(ownerId);
      } catch (e) {
        put("errors", ownerId, errorMessage(e));
      }
    },

    reveal: async (ownerId) => {
      if (!(await ready())) return null;
      try {
        return await api.revealOAuth2Token(ownerId);
      } catch (e) {
        put("errors", ownerId, errorMessage(e));
        return null;
      }
    },
  };
});
