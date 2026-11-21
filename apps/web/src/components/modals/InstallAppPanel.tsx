import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { ClientPlatform } from "../../types/client";
import { ANDROID_APK_URL, detectClientPlatform } from "../../utils/clientPlatform";

export function InstallAppPanel() {
  const [platform] = useState<ClientPlatform>(() => detectClientPlatform());
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrError, setQrError] = useState(false);
  const pageUrl = typeof window !== "undefined" ? `${window.location.origin}/` : "https://jansee.cn/";

  useEffect(() => {
    // 安卓端只提供下载按钮，不生成二维码；二维码仅 PC 端使用。
    if (platform === "android") return;
    let active = true;
    QRCode.toDataURL(pageUrl, {
      width: 200,
      margin: 1,
      color: { dark: "#202124", light: "#FFFFFF" },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [platform, pageUrl]);

  return (
    <>
      <h2 id="header-panel-title" className="visually-hidden">安装 App</h2>

      {platform === "ios" ? (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">添加到主屏幕</p>
          <p className="install-section-copy">iPhone 无需下载安装包。用 Safari 打开本页，按下面两步操作即可。</p>
          <ol className="install-steps">
            <li>
              <span className="install-step-num">1</span>
              <span>点击 Safari 底部的<strong>分享</strong>按钮（方框带向上箭头）</span>
            </li>
            <li>
              <span className="install-step-num">2</span>
              <span>在菜单里选择<strong>添加到主屏幕</strong>，确认后桌面就会出现简兮图标</span>
            </li>
          </ol>
          <p className="install-note">请使用 Safari 浏览器操作，其他浏览器可能不支持添加到主屏幕。</p>
        </div>
      ) : platform === "android" ? (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">安装安卓客户端</p>
          <p className="install-section-copy">下载安装包后按提示完成安装。若系统提示“未知来源”，请在设置中允许本应用安装。</p>
          <a className="credit-buy-button install-download-button" href={ANDROID_APK_URL} download>
            下载 APK 安装包
          </a>
        </div>
      ) : (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">扫码在手机上打开</p>
          <p className="install-section-copy">用手机扫描下方二维码打开简兮，再按提示添加到主屏幕或安装客户端。</p>
          <div className="install-qr-block">
            {qrDataUrl ? (
              <img className="install-qr-image" src={qrDataUrl} alt="简兮手机版下载二维码" />
            ) : (
              <div className="install-qr-placeholder">
                {qrError ? "二维码生成失败，请用手机访问 jansee.cn" : "正在生成二维码…"}
              </div>
            )}
            <p className="install-qr-hint">支持 iPhone 与安卓手机</p>
          </div>
        </div>
      )}
    </>
  );
}

