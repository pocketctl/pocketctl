import { reactive, watch, type Ref } from "vue";
import { useAuth } from "./useAuth";
import { getRelayWs } from "./useEnv";
import { sessionScopeKey, type SessionScope } from "./useScopedSessionState";

interface BrowserFilters {
  host: string;
  agent: string;
  query: string;
  archived: boolean;
  searchOpen: boolean;
}
const empty = (): BrowserFilters => ({
  host: "",
  agent: "",
  query: "",
  archived: false,
  searchOpen: false,
});
const snapshots = new Map<string, BrowserFilters>();

// Keep list filters when opening a conversation or returning on mobile. Grants
// and server data are still fetched again; only the user's browsing choices persist.
export function useSessionBrowserFilters(scope: Readonly<Ref<SessionScope>>) {
  const { user } = useAuth();
  const state = reactive(empty());
  let key = "";
  let restoring = false;
  watch(
    [scope, () => user.value?.id],
    ([nextScope, userID]) => {
      restoring = true;
      key = userID
        ? `${getRelayWs()}:${userID}:${sessionScopeKey(nextScope)}`
        : "";
      Object.assign(state, key ? (snapshots.get(key) ?? empty()) : empty());
      restoring = false;
    },
    { immediate: true, flush: "sync" },
  );
  watch(
    state,
    () => {
      if (key && !restoring) snapshots.set(key, { ...state });
    },
    { flush: "sync" },
  );
  return state;
}
