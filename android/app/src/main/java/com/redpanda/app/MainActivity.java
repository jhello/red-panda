package com.redpanda.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.Context;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import android.webkit.GeolocationPermissions;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient.FileChooserParams;

import org.json.JSONObject;
import java.io.OutputStream;

/**
 * Thin native shell around the shared web client in assets/www.
 * The same HTML/CSS/JS is served at /app/ for the HTML5 version and can be
 * wrapped by a WKWebView shell on iOS later.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int PAPER_COLOR = Color.rgb(247, 242, 232);
    private static final int GEOLOCATION_REQUEST_CODE = 7101;

    private WebView webView;
    private FrameLayout root;
    private GeolocationPermissions.Callback geolocationCallback;
    private String geolocationOrigin;
    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingBackupBase64;
    private static final int FILE_CHOOSER_REQUEST_CODE = 7102;
    private static final int BACKUP_SAVE_REQUEST_CODE = 7103;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Allows chrome://inspect debugging while developing over adb.
        WebView.setWebContentsDebuggingEnabled(true);

        // Wrap the WebView in a container that owns the system-bar and
        // display-cutout insets (see configureSystemBars).
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER_COLOR);
        webView = new WebView(this);
        webView.setBackgroundColor(PAPER_COLOR);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback = null;
                    return false;
                }
            }
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                geolocationOrigin = origin;
                geolocationCallback = callback;
                requestPermissions(new String[] {
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                        Manifest.permission.ACCESS_FINE_LOCATION
                }, GEOLOCATION_REQUEST_CODE);
            }
        });
        webView.addJavascriptInterface(new BackupBridge(), "AndroidBackup");
        webView.addJavascriptInterface(new ClipboardBridge(), "AndroidClipboard");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // No browser installed; keep the WebView where it is.
                }
                return true;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        configureSystemBars();
        webView.loadUrl(START_URL);
    }

    private class BackupBridge {
        @JavascriptInterface
        public void saveBackup(String filename, String base64) {
            runOnUiThread(() -> {
                pendingBackupBase64 = base64;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                // octet-stream keeps the .rpd name instead of letting the picker
                // append .gz for the gzip MIME type. The file is still gzip data.
                intent.setType("application/octet-stream");
                intent.putExtra(Intent.EXTRA_TITLE, filename);
                try {
                    startActivityForResult(intent, BACKUP_SAVE_REQUEST_CODE);
                } catch (Exception error) {
                    pendingBackupBase64 = null;
                    reportBackupSave(false, error.getMessage());
                }
            });
        }
    }

    private class ClipboardBridge {
        @JavascriptInterface
        public void copyToClipboard(String text) {
            runOnUiThread(() -> {
                if (text == null) return;
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) return;
                clipboard.setPrimaryClip(ClipData.newPlainText("Red Panda", text));
            });
        }
    }

    private void reportBackupSave(boolean ok, String message) {
        if (webView == null) return;
        String script = "window.__backupSaveResult && window.__backupSaveResult(" + ok + "," + JSONObject.quote(message == null ? "" : message) + ")";
        webView.evaluateJavascript(script, null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (fileChooserCallback != null) {
                Uri[] result = resultCode == RESULT_OK && data != null ? FileChooserParams.parseResult(resultCode, data) : null;
                fileChooserCallback.onReceiveValue(result);
                fileChooserCallback = null;
            }
        } else if (requestCode == BACKUP_SAVE_REQUEST_CODE) {
            String encoded = pendingBackupBase64;
            pendingBackupBase64 = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || encoded == null) {
                reportBackupSave(false, "Save cancelled");
                return;
            }
            try (OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                if (output == null) throw new IllegalStateException("Unable to open selected file");
                output.write(Base64.decode(encoded, Base64.DEFAULT));
                reportBackupSave(true, displayName(data.getData()));
            } catch (Exception error) {
                reportBackupSave(false, error.getMessage());
            }
        }
    }

    /** Human-readable name for a content:// URI, falling back to its last path segment. */
    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // Fall through to the URI segment below.
        }
        String segment = uri.getLastPathSegment();
        return segment == null ? "" : segment;
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(appearance, appearance);
            }
            // Pad the container (not the WebView itself — the WebView resets its
            // own padding) so page content never renders under the status bar,
            // the punch-hole cutout, or the keyboard.
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                // Consume the insets so the WebView does not apply them a second
                // time (which would double-pad or scroll content).
                return WindowInsets.CONSUMED;
            });
        } else {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == GEOLOCATION_REQUEST_CODE && geolocationCallback != null) {
            geolocationCallback.invoke(geolocationOrigin, hasLocationPermission(), false);
            geolocationCallback = null;
            geolocationOrigin = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            // 把返回键统一交给 Web 层决定：草稿浮层 / 展开预览 / 子页面 / 设置页。
            // Web 层返回 false 时，才真正退出应用。
            webView.evaluateJavascript("window.__redPandaSystemBack && window.__redPandaSystemBack()", new android.webkit.ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    boolean handled = "true".equals(value);
                    if (!handled) {
                        if (webView != null && webView.canGoBack()) {
                            webView.goBack();
                        } else {
                            finish();
                        }
                    }
                }
            });
            return;
        }
        super.onBackPressed();
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
