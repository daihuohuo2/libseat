package cn.libseat.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    static MainActivity current;
    EngineService service;
    WebView ui;
    LinearLayout root, loginBox;
    boolean bound, resumed;
    String exportData;
    ValueCallback<Uri[]> fileCallback;
    GeolocationPermissions.Callback locationCallback;
    String locationOrigin;
    final ServiceConnection connection=new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName n, IBinder b) {
            service=((EngineService.LocalBinder)b).service(); service.activity=MainActivity.this; bound=true;
            loadUi();
            if(service.login!=null && !service.loginSilent) showLogin(service.login);
        }
        @Override public void onServiceDisconnected(ComponentName n) { service=null; bound=false; }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); current=this;
        getWindow().setStatusBarColor(0xfff5f3ee); getWindow().setNavigationBarColor(0xfff5f3ee);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(0xfff5f3ee); setContentView(root);
        if(Build.VERSION.SDK_INT>=30) root.setOnApplyWindowInsetsListener((v, wi)-> { Insets i=wi.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime()); v.setPadding(i.left,i.top,i.right,i.bottom); return wi; });
        TextView loading=new TextView(this); loading.setText("座位助手\n正在启动手机预约引擎…"); loading.setPadding(28,60,28,20); root.addView(loading);
        Intent intent=new Intent(this,EngineService.class); startService(intent); bindService(intent,connection,BIND_AUTO_CREATE);
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},7);
    }
    void loadUi() {
        hideLogin(); if(ui!=null) { root.removeView(ui); ui.destroy(); }
        root.removeAllViews(); ui=new WebView(this); LocalPages.configure(ui);
        ui.setWebViewClient(new LocalPages(this)); ui.addJavascriptInterface(new MobileBridge(ui),"Mobile");
        ui.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if(!LocalPages.ORIGIN.equals(origin) && !(LocalPages.ORIGIN+"/").equals(origin)) { cb.invoke(origin,false,false); return; }
                if(checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED) { cb.invoke(origin,true,false); return; }
                if(locationCallback!=null) locationCallback.invoke(locationOrigin,false,false);
                locationCallback=cb; locationOrigin=origin;
                requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},8);
            }
            @Override public boolean onConsoleMessage(ConsoleMessage m) { if(m.messageLevel()==ConsoleMessage.MessageLevel.ERROR) android.util.Log.e("LibseatUI",m.message()+" line "+m.lineNumber()); return true; }
            @Override public boolean onJsAlert(WebView v,String url,String text,JsResult result) { new AlertDialog.Builder(MainActivity.this).setMessage(text).setPositiveButton("知道了",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show(); return true; }
            @Override public boolean onJsConfirm(WebView v,String url,String text,JsResult result) { new AlertDialog.Builder(MainActivity.this).setMessage(text).setPositiveButton("确认",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true; }
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> cb,FileChooserParams params) {
                if(fileCallback!=null) fileCallback.onReceiveValue(null); fileCallback=cb;
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE); startActivityForResult(i,10); return true;
            }
        });
        root.addView(ui,new LinearLayout.LayoutParams(-1,0,1));
        ui.loadUrl(LocalPages.ORIGIN+"/index.html");
    }
    void showLogin(WebView view) {
        hideLogin(); if(ui!=null) ui.setVisibility(View.GONE);
        loginBox=new LinearLayout(this); loginBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout toolbar=new LinearLayout(this); toolbar.setPadding(12,6,12,6);
        Button back=new Button(this); back.setText("返回助手"); back.setOnClickListener(v->{ service.loginError="已返回助手，可重新登录"; service.closeLogin(); });
        TextView title=new TextView(this); title.setText("学校官网 · 安全登录"); title.setGravity(Gravity.CENTER_VERTICAL); title.setPadding(12,0,0,0);
        toolbar.addView(back); toolbar.addView(title,new LinearLayout.LayoutParams(0,-1,1)); loginBox.addView(toolbar);
        if(view.getParent() instanceof ViewGroup) ((ViewGroup)view.getParent()).removeView(view);
        loginBox.addView(view,new LinearLayout.LayoutParams(-1,0,1)); root.addView(loginBox,new LinearLayout.LayoutParams(-1,0,1));
    }
    void hideLogin() { if(loginBox!=null) { loginBox.removeAllViews(); root.removeView(loginBox); loginBox=null; } if(ui!=null) ui.setVisibility(View.VISIBLE); }
    void openOfficial(String url) { try { startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url))); } catch(ActivityNotFoundException e) { Toast.makeText(this,"请安装浏览器后打开学校官网",Toast.LENGTH_LONG).show(); } }
    @Override public void onBackPressed() {
        if(loginBox!=null && service!=null) { service.loginError="登录已取消"; service.closeLogin(); return; }
        if(ui!=null) ui.evaluateJavascript("mobileBack()", result->{ if(!"true".equals(result)) moveTaskToBack(true); });
        else moveTaskToBack(true);
    }
    @Override protected void onResume() { super.onResume(); resumed=true; current=this; if(ui!=null) { ui.onResume(); ui.evaluateJavascript("window.dispatchEvent(new Event('focus'))",null); } }
    @Override protected void onPause() { resumed=false; if(ui!=null) ui.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        if(locationCallback!=null) { locationCallback.invoke(locationOrigin,false,false); locationCallback=null; }
        if(service!=null && service.activity==this) service.activity=null;
        if(bound) unbindService(connection); bound=false;
        if(ui!=null) { ui.destroy(); ui=null; }
        if(current==this) current=null; super.onDestroy();
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(request,permissions,results);
        if(request==8 && locationCallback!=null) {
            locationCallback.invoke(locationOrigin,checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED,false);
            locationCallback=null;
        }
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==10 && fileCallback!=null) { fileCallback.onReceiveValue(result==RESULT_OK && data!=null ? new Uri[]{data.getData()}:null); fileCallback=null; }
        if(request==11 && result==RESULT_OK && data!=null && exportData!=null) {
            try(OutputStream out=getContentResolver().openOutputStream(data.getData())) { out.write(exportData.getBytes(StandardCharsets.UTF_8)); Toast.makeText(this,"方案已导出",Toast.LENGTH_SHORT).show(); }
            catch(Exception e) { Toast.makeText(this,"导出失败，请重试",Toast.LENGTH_LONG).show(); }
        }
        if(request==11) exportData=null;
        if(request==12 && result==RESULT_OK && data!=null && data.getData()!=null) {
            final Uri document=data.getData();
            new Thread(()->{
                try {
                    byte[] bytes=EngineService.readAll(getContentResolver().openInputStream(document));
                    if(bytes.length>2000000) throw new IOException("File too large");
                    String text=new String(bytes,StandardCharsets.UTF_8);
                    runOnUiThread(()->{ if(ui!=null) ui.evaluateJavascript("importPlansFromText("+JSONObject.quote(text)+")",null); });
                } catch(Exception e) { runOnUiThread(()->Toast.makeText(this,"无法读取方案文件，请选择小于 2 MB 的 JSON 文件",Toast.LENGTH_LONG).show()); }
            },"libseat-import").start();
        }
    }
    class MobileBridge {
        final WebView page; MobileBridge(WebView page) { this.page=page; }
        @JavascriptInterface public boolean isDemo() { return service!=null && service.demo; }
        @JavascriptInterface public boolean notificationsAllowed() { return service!=null && service.notificationsAllowed(); }
        @JavascriptInterface public void api(int id,String path,String method,String body) { runOnUiThread(()->{
            if(service==null || page!=ui) return;
            if(!path.matches("/api/(?:[a-z-]+|renewal/(?:start|stop|check))") || (!method.equals("GET") && !method.equals("POST")) || body.length()>2000000) {
                page.evaluateJavascript("mobileResult("+id+",400,"+JSONObject.quote("{\"ok\":false,\"message\":\"无效请求\"}")+")",null); return;
            }
            try { if(path.equals("/api/start") || path.equals("/api/renewal/start") || path.equals("/api/watch-start")) service.enterForeground(); }
            catch(Exception e) { page.evaluateJavascript("mobileResult("+id+",200,"+JSONObject.quote("{\"ok\":false,\"message\":\"系统不允许启动后台任务，请返回应用后重试\"}")+")",null); return; }
            service.dispatch(path,method,body,(code,text)->{ if(page==ui) page.evaluateJavascript("mobileResult("+id+","+code+","+JSONObject.quote(text)+")",null); });
        }); }
        @JavascriptInterface public void switchMode(boolean demo) { runOnUiThread(()->{ if(service!=null) service.switchMode(demo,()->loadUi()); }); }
        @JavascriptInterface public void notificationSettings() { runOnUiThread(()->{
            if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},7);
            else startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()));
        }); }
        @JavascriptInterface public void exportPlans(String text) { runOnUiThread(()->{
            try { JSONObject json=new JSONObject(text); if(!"libseat".equals(json.optString("app")) || text.length()>2000000) return; exportData=text;
                startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"座位助手方案.json"),11);
            } catch(Exception e) { Toast.makeText(MainActivity.this,"无法导出方案",Toast.LENGTH_SHORT).show(); }
        }); }
        @JavascriptInterface public void importPlans() { runOnUiThread(()->startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE),12)); }
    }
}
