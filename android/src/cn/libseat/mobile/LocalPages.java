package cn.libseat.mobile;

import android.content.Context;
import android.net.Uri;
import android.webkit.*;
import java.io.*;
import java.util.*;

final class LocalPages extends WebViewClient {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    private final Context context;
    LocalPages(Context context) { this.context = context; }
    static void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        view.setBackgroundColor(0xfff5f3ee);
    }
    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (ORIGIN.equals(url.getScheme() + "://" + url.getHost())) return false;
        // The privileged WebView never navigates to remote content.
        if ("https".equals(url.getScheme()) && MainActivity.current != null) MainActivity.current.openOfficial(url.toString());
        return true;
    }
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        if (!"https".equals(u.getScheme()) || !"appassets.androidplatform.net".equals(u.getHost())) {
            // Only passive remote images may load; CSP disallows remote scripts and frames.
            if ("https".equals(u.getScheme()) && !request.isForMainFrame()) return null;
            return empty();
        }
        String name = u.getPath();
        if (name == null || name.equals("/")) name = "/index.html";
        name = name.substring(1);
        if (!name.matches("[a-zA-Z0-9_.-]+") || name.contains("..")) return empty();
        String mime = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".png") ? "image/png" : name.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
        try {
            Map<String,String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, context.getAssets().open(name));
        } catch (IOException e) { return empty(); }
    }
    private WebResourceResponse empty() { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
}
