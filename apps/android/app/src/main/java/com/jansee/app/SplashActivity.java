package com.jansee.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/**
 * 启动页：展示 windowBackground 里的完整品牌标识（SplashTheme），
 * 短暂停留后进入主 WebView Activity。noHistory=true 使其不进入返回栈。
 */
public class SplashActivity extends Activity {
    private static final long SPLASH_DELAY_MS = 1200L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 启动页布局：logo 垂直居中 + slogan 沉底（与 windowBackground 冷启动图一致）
        setContentView(R.layout.activity_splash);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            startActivity(new Intent(this, MainActivity.class));
            finish();
        }, SPLASH_DELAY_MS);
    }
}
