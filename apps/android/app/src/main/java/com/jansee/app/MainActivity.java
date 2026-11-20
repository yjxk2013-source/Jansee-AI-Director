package com.jansee.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.TextUtils;
import android.util.Log;
import android.view.KeyEvent;
import android.speech.RecognizerIntent;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.ArrayList;
import org.json.JSONObject;

/**
 * JANSEE 安卓客户端外壳：加载线上 PWA（jansee.cn），提供文件选择/下载等原生桥接。
 * 与 PWA 共用同一套界面与业务逻辑，本壳只负责平台能力。
 */
public class MainActivity extends Activity {
    private static final String TAG = "JanseeWebView";
    private static final String APP_URL = "https://jansee.cn/";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_PERMISSIONS = 1004;
    private static final int REQ_VOICE = 1005;
    private static final int REQ_VOICE_PERMISSION = 1006;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean voiceStartPending = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestNecessaryPermissions();

        webView = new WebView(this);
        setContentView(webView);
        configureWebView();
        webView.addJavascriptInterface(new VoiceBridge(), "JanseeVoice");
        webView.loadUrl(APP_URL);
    }

    private void requestNecessaryPermissions() {
        String[] needed = {
                Manifest.permission.CAMERA,
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.RECORD_AUDIO
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed = new String[]{
                    Manifest.permission.CAMERA,
                    Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.RECORD_AUDIO
            };
        }
        boolean allGranted = true;
        for (String p : needed) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                allGranted = false;
                break;
            }
        }
        if (!allGranted) {
            requestPermissions(needed, REQ_PERMISSIONS);
        }
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setTextZoom(100); // 关闭 WebView 字体放大，避免输入框聚焦时页面被撑大
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " JanseeAndroid/4.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme();
                if (scheme == null) return false;
                if (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) {
                    String host = uri.getHost();
                    if (host != null && (host.equals("jansee.cn") || host.endsWith(".jansee.cn"))) {
                        return false; // 站内，WebView 内打开
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        Log.w(TAG, "no browser for " + uri, e);
                    }
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    Log.w(TAG, "no handler for " + uri, e);
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    Log.e(TAG, "main frame error: " + error.getDescription());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent chooser = params.createIntent();
                try {
                    startActivityForResult(Intent.createChooser(chooser, "选择素材"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (!TextUtils.isEmpty(cookie)) req.addRequestHeader("Cookie", cookie);
            req.setTitle(fileName);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            try {
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(req);
                    Toast.makeText(MainActivity.this, "开始下载：" + fileName, Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Log.e(TAG, "download failed", e);
                Toast.makeText(MainActivity.this, "下载失败，请用浏览器打开", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** WebView 中的语音按钮调用系统语音识别，避免依赖 WebView 不稳定支持的 Web Speech API。 */
    public class VoiceBridge {
        @JavascriptInterface
        public void start() {
            runOnUiThread(MainActivity.this::startVoiceRecognition);
        }

        @JavascriptInterface
        public void cancel() {
            runOnUiThread(() -> {
                try {
                    finishActivity(REQ_VOICE);
                } catch (Exception ignored) {
                    // 没有正在进行的语音识别时忽略
                }
            });
        }
    }

    private void startVoiceRecognition() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            voiceStartPending = true;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_VOICE_PERMISSION);
            return;
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "说出你的创作想法");
        try {
            startActivityForResult(intent, REQ_VOICE);
        } catch (Exception e) {
            Log.w(TAG, "voice input unavailable", e);
            notifyVoiceError("这台设备暂不支持语音输入");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_VOICE_PERMISSION) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && voiceStartPending) {
                voiceStartPending = false;
                startVoiceRecognition();
            } else {
                voiceStartPending = false;
                notifyVoiceError("需要麦克风权限才能语音输入");
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void notifyVoiceResult(String text) {
        runVoiceScript("window.__janseeVoiceResult && window.__janseeVoiceResult(" + JSONObject.quote(text) + ")");
    }

    private void notifyVoiceError(String message) {
        runVoiceScript("window.__janseeVoiceError && window.__janseeVoiceError(" + JSONObject.quote(message == null ? "" : message) + ")");
    }

    private void runVoiceScript(String script) {
        if (webView != null) {
            webView.evaluateJavascript(script, null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {
        super.onActivityResult(requestCode, resultCode, intent);
        if (requestCode == REQ_VOICE) {
            if (resultCode == RESULT_OK && intent != null) {
                ArrayList<String> results = intent.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                String text = results == null || results.isEmpty() ? "" : results.get(0);
                if (!TextUtils.isEmpty(text)) {
                    notifyVoiceResult(text);
                } else {
                    notifyVoiceError("没有识别到语音，请重试");
                }
            } else {
                notifyVoiceError("");
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && intent != null) {
                String dataString = intent.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                } else if (intent.getClipData() != null) {
                    int count = intent.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = intent.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
