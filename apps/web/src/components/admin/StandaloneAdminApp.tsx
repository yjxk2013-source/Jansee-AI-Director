import { lazy, Suspense, useEffect, useState } from "react";
import type { AuthUser } from "../../types/client";
import { AdminLoginPanel } from "./AdminLoginPanel";

const AdminConsole = lazy(() => import("../../AdminConsole").then((m) => ({ default: m.AdminConsole })));

export function isAdminHostRequested(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  const path = window.location.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams(window.location.search);
  return host === "admin.jansee.cn" || path === "/admin" || params.get("admin") === "1" || window.location.hash === "#admin";
}

export function StandaloneAdminApp() {
  const [adminUser, setAdminUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/auth/me", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { user: AuthUser };
      })
      .then(async (payload) => {
        if (!active) return;
        if (payload?.user && !payload.user.isGuest) {
          const overviewRes = await fetch("/api/v1/admin/overview", { credentials: "include", cache: "no-store" }).catch(() => null);
          if (active && overviewRes && overviewRes.ok) {
            setAdminUser(payload.user);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (checking) {
    return (
      <main className="admin-login-screen">
        <section className="admin-login-card" style={{ textAlign: "center", padding: "48px 32px" }}>
          <div className="admin-login-mark">JANSEE <span>ADMIN</span></div>
          <p style={{ marginTop: "16px", color: "var(--jansee-text-muted, #9aa0a6)", fontSize: "14px" }}>正在连接管理控制台…</p>
        </section>
      </main>
    );
  }

  if (!adminUser) {
    return <AdminLoginPanel onSuccess={(user) => setAdminUser(user)} />;
  }

  return (
    <Suspense
      fallback={
        <main className="admin-login-screen">
          <section className="admin-login-card" style={{ textAlign: "center", padding: "48px 32px" }}>
            <div className="admin-login-mark">JANSEE <span>ADMIN</span></div>
            <p style={{ marginTop: "16px", color: "var(--jansee-text-muted, #9aa0a6)", fontSize: "14px" }}>正在载入控制台组件…</p>
          </section>
        </main>
      }
    >
      <AdminConsole onClose={() => setAdminUser(null)} />
    </Suspense>
  );
}

