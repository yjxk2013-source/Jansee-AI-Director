package com.jianxi.jansee;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;

/**
 * TWA 启动 Activity。
 *
 * 职责：
 *  1. 冷启动时展示品牌启动屏（黑底 + 红JX + 简·兮 + Jansee），见 res/layout/activity_splash.xml；
 *  2. 短暂停留后，切换到全屏 WebView 加载网页应用（TWA 效果），并保持 WebView 常驻。
 */
public class MainActivity extends AppCompatActivity {

    /** 线上服务地址（V2 主站；切域名时同步更新此处并重新发版） */
    private static final String TARGET_URL = "https://jansee.cn/";

    private static final long SPLASH_MILLIS = 1400L;

    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(Color.BLACK);
        setContentView(R.layout.activity_splash);

        handler.postDelayed(this::openWeb, SPLASH_MILLIS);
    }

    private void openWeb() {
        WebView webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        // 明确启用 viewport meta，避免部分安卓 WebView 按桌面宽度排版。
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setTextZoom(100);
        webView.setHorizontalScrollBarEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 普通 HTTP/HTTPS 导航留在 WebView 内；第三方 Scheme（如支付宝、微信支付）唤起本地原生 App
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    String url = request.getUrl().toString();
                    if (url.startsWith("alipays://") || url.startsWith("alipay://") || url.startsWith("weixin://")) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(intent);
                            return true;
                        } catch (Exception ignored) {
                            return true;
                        }
                    }
                }
                return false; // 继续由 WebView 加载
            }
        });
        // 以全屏 WebView 呈现网页应用，去掉系统浏览器壳
        setContentView(webView);
        webView.loadUrl(TARGET_URL);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
