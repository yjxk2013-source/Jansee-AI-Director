import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 首屏绘制完成后收起页面内启动页；超时兜底在 index.html 里。
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    (window as Window & { __janseeHideSplash?: () => void }).__janseeHideSplash?.();
  });
});

// PWA 缓存自愈：历史版本曾把 sw.js 当普通静态资源缓存了 7 天，导致部分老用户浏览器
// 里残留旧 SW，服务器已更新但页面仍被旧缓存喂旧 bundle（表现为"部署了却没变化"）。
// 启动时若发现有旧 SW 正在控制页面，且本版本尚未做过自愈，则注销全部 SW + 清空
// Cache Storage，然后刷新一次 loads 到最新代码；用 localStorage 标记保证只做一次。
const SW_HEAL_KEY = "jansee-sw-heal-v2";
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void (async () => {
    try {
      const healed = window.localStorage.getItem(SW_HEAL_KEY) === "1";
      const controlled = Boolean(navigator.serviceWorker.controller);
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!healed && (controlled || regs.length > 0)) {
        await Promise.all(regs.map((reg) => reg.unregister()));
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
        window.localStorage.setItem(SW_HEAL_KEY, "1");
        window.location.reload();
        return;
      }
    } catch {
      // 自愈失败不阻断应用启动，下面的注册逻辑照常进行。
    }
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // PWA 安装能力不可用时，Web 创作流程仍可正常运行。
      });
    });
  })();
}
