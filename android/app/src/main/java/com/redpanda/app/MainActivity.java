package com.redpanda.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.Context;
import android.database.Cursor;
import android.graphics.drawable.ColorDrawable;
import android.provider.DocumentsContract;
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
import android.widget.ArrayAdapter;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Thin native shell around the shared web client in assets/www.
 * The same HTML/CSS/JS is served at /app/ for the HTML5 version and can be
 * wrapped by a WKWebView shell on iOS later.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int PAPER_COLOR = Color.rgb(247, 242, 232);
    private static final int DARK_PAPER_COLOR = Color.rgb(20, 25, 26);
    private static final String PREFS_NAME = "red-panda";
    private static final String PREF_THEME = "theme_mode";
    private static final int GEOLOCATION_REQUEST_CODE = 7101;

    private WebView webView;
    private FrameLayout root;
    private int barsLeft;
    private int barsTop;
    private int barsRight;
    private int barsBottom;
    private int imeBottom;
    private String themeMode = "system";
    private boolean darkMode = false;
    private GeolocationPermissions.Callback geolocationCallback;
    private String geolocationOrigin;
    private ValueCallback<Uri[]> fileChooserCallback;
    private volatile boolean backupChooserLaunched;
    private volatile String pendingBackupBase64;
    private volatile File pendingBackupTempFile;
    private volatile String pendingBackupFilename;
    private volatile FileOutputStream stagedBackupStream;
    private final AtomicBoolean backupBusy = new AtomicBoolean(false);
    private volatile boolean backupPickerLaunched = false;
    private String pendingImportTitle;
    private String pendingImportEmptyMessage;
    private String pendingImportCancelLabel;
    private static final int FILE_CHOOSER_REQUEST_CODE = 7102;
    private static final int BACKUP_SAVE_REQUEST_CODE = 7103;
    private static final int BACKUP_PICK_TREE_REQUEST_CODE = 7104;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Remember the appearance chosen inside the web UI so the next launch
        // does not flash the light paper background before the page loads.
        themeMode = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_THEME, "system");
        if (!"light".equals(themeMode) && !"dark".equals(themeMode)) themeMode = "system";
        darkMode = "dark".equals(themeMode) || ("system".equals(themeMode) && isSystemDarkMode());
        int paperColor = darkMode ? DARK_PAPER_COLOR : PAPER_COLOR;
        getWindow().setBackgroundDrawable(new ColorDrawable(paperColor));

        // Allow chrome://inspect debugging only in debuggable builds.
        boolean isDebuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(isDebuggable);

        // Wrap the WebView in a container that owns the system-bar and
        // display-cutout insets (see configureSystemBars).
        root = new FrameLayout(this);
        root.setBackgroundColor(paperColor);
        webView = new WebView(this);
        webView.setBackgroundColor(paperColor);
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
                backupChooserLaunched = acceptsBackupFile(params.getAcceptTypes());
                try {
                    Intent intent = backupChooserLaunched ? backupDocumentIntent() : params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback = null;
                    backupChooserLaunched = false;
                    return false;
                }
            }
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                dialogBuilder()
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                dialogBuilder()
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
        webView.addJavascriptInterface(new ThemeBridge(), "AndroidTheme");
        webView.addJavascriptInterface(new BarsBridge(), "AndroidBars");
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

            @Override
            public void onPageFinished(WebView view, String url) {
                // The first insets callback may arrive before the page defines
                // __redPandaTopInset, so repeat it once the document is ready.
                publishTopInset(barsTop);
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        configureSystemBars();
        applyWindowTheme();
        webView.loadUrl(START_URL);
    }

    /** Clear staged backup state without releasing the one-backup-at-a-time lock. */
    private synchronized void clearStagedBackup() {
        if (stagedBackupStream != null) {
            try { stagedBackupStream.close(); } catch (Exception ignored) {}
            stagedBackupStream = null;
        }
        if (pendingBackupTempFile != null) {
            //noinspection ResultOfMethodCallIgnored
            pendingBackupTempFile.delete();
            pendingBackupTempFile = null;
        }
        pendingBackupFilename = null;
        pendingBackupBase64 = null;
    }

    /** Clear state and allow the next backup to start. */
    private void cleanupStagedBackup() {
        clearStagedBackup();
        backupPickerLaunched = false;
        backupBusy.set(false);
    }

    private class BackupBridge {
        @JavascriptInterface
        public void saveBackup(String filename, String base64) {
            if (!backupBusy.compareAndSet(false, true)) {
                runOnUiThread(() -> reportBackupSave(false, "busy"));
                return;
            }
            runOnUiThread(() -> {
                if (backupPickerLaunched) {
                    reportBackupSave(false, "busy");
                    backupBusy.set(false);
                    return;
                }
                backupPickerLaunched = true;
                clearStagedBackup();
                pendingBackupBase64 = base64;
                launchBackupPicker(filename);
            });
        }

        /** Start a chunked backup stream into app cache to avoid huge IPC strings. */
        @JavascriptInterface
        public boolean beginBackup(String filename) {
            if (!backupBusy.compareAndSet(false, true)) return false;
            try {
                clearStagedBackup();
                backupPickerLaunched = false;
                pendingBackupFilename = filename;
                pendingBackupTempFile = File.createTempFile("red-panda-backup-", ".rpd", getCacheDir());
                stagedBackupStream = new FileOutputStream(pendingBackupTempFile);
                return true;
            } catch (Exception error) {
                cleanupStagedBackup();
                runOnUiThread(() -> reportBackupSave(false, "streamStartFailed"));
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean appendBackupChunk(String base64Chunk) {
            try {
                if (stagedBackupStream == null || base64Chunk == null) return false;
                byte[] decoded = Base64.decode(base64Chunk, Base64.DEFAULT);
                stagedBackupStream.write(decoded);
                return true;
            } catch (Exception error) {
                cleanupStagedBackup();
                runOnUiThread(() -> reportBackupSave(false, "chunkWriteFailed"));
                return false;
            }
        }

        @JavascriptInterface
        public synchronized void finishBackup() {
            if (!backupBusy.get() || backupPickerLaunched) return;
            try {
                if (stagedBackupStream != null) {
                    stagedBackupStream.flush();
                    stagedBackupStream.close();
                    stagedBackupStream = null;
                }
                if (pendingBackupTempFile == null || !pendingBackupTempFile.exists()) {
                    runOnUiThread(() -> {
                        reportBackupSave(false, "bufferMissing");
                        cleanupStagedBackup();
                    });
                    return;
                }
                backupPickerLaunched = true;
                final String filename =
                    pendingBackupFilename != null ? pendingBackupFilename : "red-panda-backup.rpd";
                runOnUiThread(() -> launchBackupPicker(filename));
            } catch (Exception error) {
                cleanupStagedBackup();
                runOnUiThread(() -> reportBackupSave(false, "saveFailed"));
            }
        }

        @JavascriptInterface
        public void cancelBackup() {
            runOnUiThread(MainActivity.this::cleanupStagedBackup);
        }

        /**
         * Open a folder picker, then offer only files whose names end in .rpd or
         * .json. The system document picker greys out mismatched MIME types but
         * still lists them, so the filtered list is rendered here instead.
         */
        @JavascriptInterface
        public void pickBackupFile(String title, String emptyMessage, String cancelLabel) {
            runOnUiThread(() -> launchBackupImportTree(title, emptyMessage, cancelLabel));
        }
    }

    /**
     * The backup input is the only non-media file chooser in the app. Chromium
     * normalizes custom suffixes such as .rpd unpredictably, so detect the
     * media chooser instead of trying to match a particular MIME string.
     */
    private static boolean acceptsBackupFile(String[] types) {
        if (types == null || types.length == 0) return false;
        for (String type : types) {
            if (type == null) continue;
            String value = type.toLowerCase(Locale.ROOT);
            if (value.startsWith("image/") || value.startsWith("video/") || value.startsWith("audio/")) {
                return false;
            }
        }
        return true;
    }

    /**
     * Android has no registered MIME type for .rpd, so it reports those files as
     * application/octet-stream. Restricting the picker to JSON + octet-stream
     * hides unrelated files (images, text, video) while still showing backups.
     */
    private static Intent backupDocumentIntent() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "application/octet-stream"});
        intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        return intent;
    }

    private boolean hasBackupExtension(Uri uri) {
        if (uri == null) return false;
        String name = displayName(uri);
        if (!name.contains(".")) {
            String segment = uri.getLastPathSegment();
            name = segment == null ? "" : segment;
        }
        return hasBackupExtensionName(name);
    }

    private boolean hasBackupExtensionName(String name) {
        if (name == null) return false;
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".rpd") || lower.endsWith(".json");
    }

    private static final class BackupFile {
        final Uri uri;
        final String label;

        BackupFile(Uri uri, String label) {
            this.uri = uri;
            this.label = label;
        }
    }

    /** Ask the user for a folder and remember the localized dialog labels. */
    private void launchBackupImportTree(String title, String emptyMessage, String cancelLabel) {
        pendingImportTitle = title;
        pendingImportEmptyMessage = emptyMessage;
        pendingImportCancelLabel = cancelLabel;
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            // Most devices keep backups in Download; open there when possible.
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                    DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download"));
            startActivityForResult(intent, BACKUP_PICK_TREE_REQUEST_CODE);
        } catch (Exception error) {
            notifyImportPickerCancelled();
        }
    }

    /** Recursively collect only files with a backup suffix from a SAF tree. */
    private void collectBackupFiles(Uri treeUri, String parentId, String prefix, List<BackupFile> out, int depth) {
        if (out.size() >= 200 || depth > 6) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
        };
        try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext() && out.size() < 200) {
                String id = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID));
                String name = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME));
                String mime = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE));
                if (id == null || name == null) continue;
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    collectBackupFiles(treeUri, id, prefix + name + "/", out, depth + 1);
                } else if (hasBackupExtensionName(name)) {
                    out.add(new BackupFile(documentUri, prefix + name));
                }
            }
        } catch (Exception ignored) {
            // Unreadable branches are skipped; other folders may still contain backups.
        }
    }

    /** Stream only the chosen backup file back into the WebView in small chunks. */
    private void deliverBackupFile(BackupFile file) {
        final int chunkBytes = 256 * 1024;
        try (InputStream input = getContentResolver().openInputStream(file.uri)) {
            if (input == null) throw new IllegalStateException("openFailed");
            List<String> chunks = new ArrayList<>();
            byte[] buffer = new byte[chunkBytes];
            int read;
            while ((read = input.read(buffer)) != -1) {
                chunks.add(Base64.encodeToString(Arrays.copyOf(buffer, read), Base64.NO_WRAP));
            }
            String name = file.label.substring(file.label.lastIndexOf('/') + 1);
            for (int i = 0; i < chunks.size(); i++) {
                webView.evaluateJavascript("window.__backupImportChunk && window.__backupImportChunk("
                        + i + "," + chunks.size() + "," + JSONObject.quote(chunks.get(i)) + ")", null);
            }
            webView.evaluateJavascript("window.__backupImportReady && window.__backupImportReady("
                    + JSONObject.quote(name) + "," + chunks.size() + ")", null);
        } catch (Exception error) {
            notifyImportPickerCancelled();
        }
    }

    private void notifyImportPickerCancelled() {
        webView.evaluateJavascript(
                "window.__redPandaImportPickerCancelled && window.__redPandaImportPickerCancelled()", null);
    }

    private void launchBackupPicker(String filename) {
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
            cleanupStagedBackup();
            reportBackupSave(false, "saveFailed");
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

    /** Gives the page the top inset synchronously, before the first paint. */
    private class BarsBridge {
        @JavascriptInterface
        public int getTopInsetDp() {
            return Math.round(barsTop / getResources().getDisplayMetrics().density);
        }
    }

    /** Bridges the web appearance setting to the Android window and system bars. */
    private class ThemeBridge {
        @JavascriptInterface
        public boolean isSystemDark() {
            return isSystemDarkMode();
        }

        @JavascriptInterface
        public void apply(String mode, boolean dark) {
            String normalized = "light".equals(mode) || "dark".equals(mode) ? mode : "system";
            runOnUiThread(() -> {
                themeMode = normalized;
                darkMode = dark;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                        .putString(PREF_THEME, normalized).apply();
                applyWindowTheme();
            });
        }
    }

    private boolean isSystemDarkMode() {
        int night = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    private AlertDialog.Builder dialogBuilder() {
        int theme = darkMode
                ? android.R.style.Theme_Material_Dialog_Alert
                : android.R.style.Theme_Material_Light_Dialog_Alert;
        return new AlertDialog.Builder(this, theme);
    }

    /** Repaint the native layers to match the web theme. */
    private void applyWindowTheme() {
        int paperColor = darkMode ? DARK_PAPER_COLOR : PAPER_COLOR;
        if (root != null) root.setBackgroundColor(paperColor);
        if (webView != null) webView.setBackgroundColor(paperColor);
        Window window = getWindow();
        if (window != null) window.setBackgroundDrawable(new ColorDrawable(paperColor));
        applySystemBarAppearance();
    }

    private void applySystemBarAppearance() {
        Window window = getWindow();
        if (window == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller == null) return;
            int lightAppearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            int appearance = darkMode ? 0 : lightAppearance;
            controller.setSystemBarsAppearance(appearance, lightAppearance);
        } else {
            int flags = 0;
            if (!darkMode) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if ("system".equals(themeMode)) {
            darkMode = isSystemDarkMode();
            applyWindowTheme();
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.__redPandaSystemThemeChanged && window.__redPandaSystemThemeChanged()", null);
            }
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
        if (requestCode == BACKUP_PICK_TREE_REQUEST_CODE) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                notifyImportPickerCancelled();
                return;
            }
            final Uri treeUri = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Temporary access is enough for this import.
            }
            final List<BackupFile> files = new ArrayList<>();
            String rootId;
            try {
                rootId = DocumentsContract.getTreeDocumentId(treeUri);
            } catch (Exception error) {
                rootId = null;
            }
            if (rootId != null) collectBackupFiles(treeUri, rootId, "", files, 0);
            if (files.isEmpty()) {
                webView.evaluateJavascript("window.__redPandaBackupFilesEmpty && window.__redPandaBackupFilesEmpty("
                        + JSONObject.quote(pendingImportEmptyMessage == null ? "" : pendingImportEmptyMessage) + ")", null);
                return;
            }
            final String[] labels = new String[files.size()];
            for (int i = 0; i < files.size(); i++) labels[i] = files.get(i).label;
            new AlertDialog.Builder(this)
                    .setTitle(pendingImportTitle)
                    .setItems(labels, (dialog, which) -> deliverBackupFile(files.get(which)))
                    .setNegativeButton(pendingImportCancelLabel, (dialog, which) -> notifyImportPickerCancelled())
                    .setOnCancelListener(dialog -> notifyImportPickerCancelled())
                    .show();
        } else if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (fileChooserCallback != null) {
                Uri[] result = resultCode == RESULT_OK && data != null ? FileChooserParams.parseResult(resultCode, data) : null;
                if (backupChooserLaunched) {
                    if (result != null) {
                        for (Uri uri : result) {
                            if (!hasBackupExtension(uri)) {
                                result = null;
                                webView.evaluateJavascript(
                                        "window.__redPandaInvalidImportFile && window.__redPandaInvalidImportFile()", null);
                                break;
                            }
                        }
                    }
                    backupChooserLaunched = false;
                }
                fileChooserCallback.onReceiveValue(result);
                fileChooserCallback = null;
            }
        } else if (requestCode == BACKUP_SAVE_REQUEST_CODE) {
            String encoded = pendingBackupBase64;
            pendingBackupBase64 = null;
            File tempFile = pendingBackupTempFile;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || (encoded == null && tempFile == null)) {
                cleanupStagedBackup();
                reportBackupSave(false, "cancelled");
                return;
            }
            try (OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                if (output == null) throw new IllegalStateException("openFailed");
                if (tempFile != null && tempFile.exists()) {
                    try (InputStream input = new FileInputStream(tempFile)) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = input.read(buffer)) != -1) {
                            output.write(buffer, 0, read);
                        }
                    }
                } else if (encoded != null) {
                    output.write(Base64.decode(encoded, Base64.DEFAULT));
                }
                reportBackupSave(true, displayName(data.getData()));
            } catch (Exception error) {
                reportBackupSave(false, "saveFailed");
            } finally {
                cleanupStagedBackup();
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

    /**
     * The root owns bottom/side insets only. The WebView always extends under the
     * status bar and the page adds the top inset itself, so navigating to the
     * full-bleed plan page never resizes the viewport (and never makes the old
     * page jump before the new one appears).
     */
    private void applyRootPadding() {
        if (root == null) return;
        root.setPadding(barsLeft, 0, barsRight, Math.max(barsBottom, imeBottom));
        publishTopInset(barsTop);
    }

    /** Tell the page how much top padding its content still needs (dp). */
    private void publishTopInset(int topPx) {
        if (webView == null) return;
        float topDp = topPx / getResources().getDisplayMetrics().density;
        webView.evaluateJavascript(
                "window.__redPandaTopInset && window.__redPandaTopInset(" + topDp + ")", null);
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
                barsLeft = bars.left;
                barsTop = bars.top;
                barsRight = bars.right;
                barsBottom = bars.bottom;
                imeBottom = ime.bottom;
                applyRootPadding();
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
        cleanupStagedBackup();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
