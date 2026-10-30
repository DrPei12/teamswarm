import { useEffect, useState } from "react";
import type { PermissionOptions } from "@team/contracts/runtime";
import { api } from "./service";
import { cachedCatalog } from "./modelCatalogCache";

export function usePermissionOptions(harness: string) {
  const [catalog, setCatalog] = useState<Record<string, PermissionOptions>>({});
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void cachedCatalog("permission-options", () =>
      api<Record<string, PermissionOptions>>("/product/permission-options"),
    )
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  return {
    options: catalog[harness],
    error,
    retry: () => setRetry((n) => n + 1),
  };
}
