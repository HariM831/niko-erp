/**
 * `useApp` — the store shape the ported screens read.
 *
 * They only ever want the signed-in user and whether they are an admin, both
 * of which niko already has in its auth context. This adapts one to the other
 * so the pages need no edit.
 */
import { useAuth } from "../auth";

export function useApp() {
  const { user } = useAuth();
  const isAdmin = user?.permissions["*"]?.includes("*") ?? false;
  return {
    state: {
      currentUser: {
        id: user?.id ?? "",
        name: user?.name ?? "",
        isAdmin,
        role: user?.roleName ?? "",
      },
    },
  };
}
