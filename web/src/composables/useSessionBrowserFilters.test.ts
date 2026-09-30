import { effectScope, computed, ref } from "vue";
import { expect, test, vi } from "vitest";
import { useSessionBrowserFilters } from "./useSessionBrowserFilters";
import type { SessionScope } from "./useScopedSessionState";
const account = ref({ id: 701 });
vi.mock("./useAuth", () => ({ useAuth: () => ({ user: account }) }));
vi.mock("./useEnv", () => ({ getRelayWs: () => "ws://filters.example/ws" }));

test("restores filters when returning to the same scope and isolates teams and accounts", () => {
  const scope = ref<SessionScope>({ type: "team", teamId: "filter-alpha" });
  const mounted = effectScope();
  const filters = mounted.run(() =>
    useSessionBrowserFilters(computed(() => scope.value)),
  )!;
  filters.host = "host-alpha";
  filters.agent = "codex";
  filters.archived = true;
  scope.value = { type: "team", teamId: "filter-beta" };
  expect(filters.host).toBe("");
  expect(filters.archived).toBe(false);
  filters.host = "host-beta";
  scope.value = { type: "team", teamId: "filter-alpha" };
  expect(filters).toMatchObject({
    host: "host-alpha",
    agent: "codex",
    archived: true,
  });
  account.value = { id: 702 };
  expect(filters.host).toBe("");
  account.value = { id: 701 };
  expect(filters.host).toBe("host-alpha");
  mounted.stop();
  const returning = effectScope();
  expect(returning.run(() => useSessionBrowserFilters(scope))!.host).toBe(
    "host-alpha",
  );
  returning.stop();
});
