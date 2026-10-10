package cn.libseat.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.Cipher;
import javax.crypto.spec.*;

public class EngineService extends Service {
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService network = Executors.newFixedThreadPool(3);
    final Map<Integer, Runnable> timers = new HashMap<>();
    final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    final Map<Integer, Reply> replies = new HashMap<>();
    final List<Runnable> waiting = new ArrayList<>();
    WebView engine, login;
    boolean ready, foreground, running, pendingBooking, checkingBooking, renewing;
    String taskText = "";
    volatile boolean demo;
    int sequence;
    volatile int generation;
    long foregroundSince;
    volatile String loginToken = "", loginError = "";
    boolean loginSilent;
    int loginGeneration;
    PowerManager.WakeLock wake;
    MainActivity activity;
    interface Reply { void done(int code, String body); }
    public class LocalBinder extends Binder { EngineService service() { return EngineService.this; } }
    @Override public IBinder onBind(Intent intent) { return new LocalBinder(); }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("task", "运行中的任务", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel("booking", "预约结果", NotificationManager.IMPORTANCE_HIGH));
        wake = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "libseat:booking");
        wake.setReferenceCounted(false);
        demo = getSharedPreferences("mobile", MODE_PRIVATE).getBoolean("demo", false);
        createEngine();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) dispatch("/api/stop", "POST", "{}", (c,b) -> {});
        return START_NOT_STICKY; // Never resume booking after a system/process restart.
    }
    void createEngine() {
        ready = false; generation++;
        engine = new WebView(this); LocalPages.configure(engine);
        engine.setWebViewClient(new LocalPages(this));
        engine.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e("LibseatEngine", m.message() + " line " + m.lineNumber());
                return true;
            }
        });
        engine.addJavascriptInterface(new NativeBridge(generation), "Native");
        engine.loadUrl(LocalPages.ORIGIN + "/engine.html");
    }
    void eval(String js) { if (engine != null) engine.evaluateJavascript(js, null); }
    void dispatch(String path, String method, String body, Reply reply) {
        if (!ready) { waiting.add(() -> dispatch(path,method,body,reply)); return; }
        final int id = ++sequence; replies.put(id, reply);
        eval("androidDispatch(" + id + "," + JSONObject.quote(path) + "," + JSONObject.quote(method) + "," + JSONObject.quote(body) + ")");
        main.postDelayed(() -> { Reply r = replies.remove(id); if (r != null) r.done(504,"{\"ok\":false,\"message\":\"本地引擎响应超时\"}"); }, 45000);
    }
    void switchMode(boolean value, Runnable done) {
        if (running || checkingBooking || pendingBooking || renewing) return;
        dispatch("/api/status", "GET", "{}", (code, body) -> {
            try {
                JSONObject s = new JSONObject(body);
                if (blocksModeSwitch(s)) return;
                for (Runnable r : timers.values()) main.removeCallbacks(r); timers.clear();
                for (HttpURLConnection c : requests.values()) network.execute(c::disconnect); requests.clear();
                closeLogin(); engine.destroy(); engine = null;
                for (Reply r : replies.values()) r.done(409,"{\"ok\":false,\"message\":\"正在切换模式\"}"); replies.clear();
                demo = value; getSharedPreferences("mobile", MODE_PRIVATE).edit().putBoolean("demo",demo).apply();
                createEngine(); done.run();
            } catch (JSONException e) { Log.e("LibseatEngine", "Mode switch failed"); }
        });
    }
    static boolean blocksModeSwitch(JSONObject s) {
        JSONObject renewal=s.optJSONObject("renewal"), management=s.optJSONObject("bookingManagement");
        return s.optBoolean("running") || s.optBoolean("checkingBooking") || !s.isNull("pendingBooking")
            || (renewal!=null && (renewal.optBoolean("active") || renewal.optBoolean("busy") || renewal.optString("phase").endsWith("-unknown")))
            || (management!=null && (management.optBoolean("busy") || management.optBoolean("checking") || !management.isNull("pendingAction")));
    }
    boolean notificationsAllowed() { return getSystemService(NotificationManager.class).areNotificationsEnabled(); }
    PendingIntent openIntent() { return PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE); }
    Notification taskNotice(String text) {
        PendingIntent stop = PendingIntent.getService(this,1,new Intent(this,EngineService.class).setAction("STOP"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,"task").setSmallIcon(android.R.drawable.ic_menu_recent_history).setContentTitle(demo ? "座位助手 · 演示任务" : "座位助手正在运行")
            .setContentText(text).setContentIntent(openIntent()).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止任务",stop).build()).build();
    }
    void enterForeground() {
        if (foreground) return;
        if (Build.VERSION.SDK_INT >= 29) startForeground(1,taskNotice("正在检查座位，可点击返回应用"),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(1,taskNotice("正在检查座位，可点击返回应用"));
        foreground = true; foregroundSince = System.currentTimeMillis(); wake.acquire(6*60*60*1000L);
    }
    void leaveForeground() {
        if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground=false; }
        if (wake.isHeld()) wake.release();
    }
    @Override public void onTimeout(int startId, int fgsType) {
        dispatch("/api/stop","POST","{}",(c,b)->{});
        leaveForeground();
        notifyText("后台任务已停止", "已达到系统后台运行时限，请打开应用检查任务状态。", 3);
        stopSelf();
    }
    void notifyText(String title, String text, int id) {
        if (!notificationsAllowed()) return;
        getSystemService(NotificationManager.class).notify(id,new Notification.Builder(this,"booking").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(openIntent()).setAutoCancel(true).build());
    }
    void startLogin(boolean silent) {
        closeLogin(); loginToken=""; loginError=""; loginSilent=silent;
        if (demo) { loginError="演示模式无需登录"; return; }
        if (!silent && (activity==null || !activity.resumed)) { loginError="请返回应用，点击登录学校账号"; return; }
        final int epoch = ++loginGeneration;
        login = new WebView(activity != null ? activity : this); LocalPages.configure(login);
        // Remote school pages get no JavascriptInterface or privileged bridge.
        android.webkit.CookieManager.getInstance().setAcceptCookie(true);
        login.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u=r.getUrl(); String host=u.getHost();
                return !("https".equals(u.getScheme()) && host!=null && (host.equals("csu.edu.cn") || host.endsWith(".csu.edu.cn")));
            }
            @Override public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler h, android.net.http.SslError e) {
                h.cancel(); loginError="学校网站证书校验失败，请检查手机时间或网络";
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if(r.isForMainFrame()) loginError="学校登录页面加载失败，请检查网络后重试";
            }
        });
        login.loadUrl("https://libzw.csu.edu.cn/");
        if (!silent) activity.showLogin(login);
        final long start=System.currentTimeMillis();
        Runnable poll=new Runnable() { public void run() {
            if (epoch!=loginGeneration || login==null || !loginToken.isEmpty() || !loginError.isEmpty()) return;
            if (silent && System.currentTimeMillis()-start>20000) { loginError="登录状态需要手动更新"; return; }
            String url=login.getUrl();
            if (url!=null && "libzw.csu.edu.cn".equals(Uri.parse(url).getHost()) && "https".equals(Uri.parse(url).getScheme())) {
                login.evaluateJavascript("location.origin==='https://libzw.csu.edu.cn'?sessionStorage.getItem('token'):null", value -> {
                    if (epoch!=loginGeneration) return;
                    try { Object token=new JSONTokener(value).nextValue(); if(token instanceof String && !((String)token).isEmpty()) { loginToken=(String)token; android.webkit.CookieManager.getInstance().flush(); } } catch(Exception ignored) {}
                });
            }
            main.postDelayed(this,700);
        }}; main.postDelayed(poll,700);
    }
    void closeLogin() {
        loginGeneration++;
        if (activity!=null) activity.hideLogin();
        if (login!=null) { if(login.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup)login.getParent()).removeView(login); login.stopLoading(); login.destroy(); login=null; }
    }
    @Override public void onTaskRemoved(Intent intent) { if (!foreground) stopSelf(); }
    @Override public void onDestroy() {
        generation++; closeLogin(); leaveForeground();
        main.removeCallbacksAndMessages(null);
        for(HttpURLConnection c:requests.values()) network.execute(c::disconnect);
        network.shutdown();
        if(engine!=null) { engine.destroy(); engine=null; }
        super.onDestroy();
    }
    File dataFile(String path) throws IOException {
        if (!path.matches("/data/(config\\.json|(?:bookings|renewal)\\.json(?:\\.tmp)?|libseat\\.log|browser-data/cookies\\.json)")
            && !(demo && path.equals("/data/demo-records.json"))) throw new IOException("不允许访问此文件");
        File root=new File(getFilesDir(),demo?"demo":"real"); root.mkdirs();
        File f=new File(root,path.substring(6));
        if(!f.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator)) throw new IOException("Invalid path");
        return f;
    }
    static byte[] readAll(InputStream in) throws IOException {
        try(InputStream input=in; ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buf=new byte[8192]; int n; while((n=input.read(buf))!=-1) { out.write(buf,0,n); if(out.size()>8*1024*1024) throw new IOException("响应内容过大"); } return out.toByteArray();
        }
    }
    class NativeBridge {
        final int epoch; NativeBridge(int epoch) { this.epoch=epoch; }
        void post(Runnable r) { main.post(()->{ if(epoch==generation && engine!=null) r.run(); }); }
        @JavascriptInterface public boolean isDemo() { return demo; }
        @JavascriptInterface public boolean notificationsAllowed() { return EngineService.this.notificationsAllowed(); }
        @JavascriptInterface public void ready() { post(()->{ ready=true; List<Runnable> tasks=new ArrayList<>(waiting); waiting.clear(); for(Runnable r:tasks) r.run(); }); }
        @JavascriptInterface public String sync(String payload) {
            JSONObject result=new JSONObject();
            try {
                if(epoch!=generation) throw new IOException("引擎已重启");
                JSONObject msg=new JSONObject(payload); String op=msg.getString("op"); JSONArray a=msg.getJSONArray("args"); Object value=JSONObject.NULL;
                if(op.equals("uuid")) value=UUID.randomUUID().toString();
                else if(op.equals("decode64")) value=new String(Base64.decode(a.getString(0),Base64.DEFAULT),StandardCharsets.UTF_8);
                else if(op.equals("aes")) {
                    Cipher cipher=Cipher.getInstance("AES/CBC/PKCS5Padding"); boolean decrypt=a.getBoolean(0);
                    cipher.init(decrypt?Cipher.DECRYPT_MODE:Cipher.ENCRYPT_MODE,new SecretKeySpec(a.getString(1).getBytes(StandardCharsets.UTF_8),"AES"),new IvParameterSpec(a.getString(2).getBytes(StandardCharsets.UTF_8)));
                    byte[] bytes=cipher.doFinal(decrypt?Base64.decode(a.getString(3),Base64.DEFAULT):a.getString(3).getBytes(StandardCharsets.UTF_8));
                    value=decrypt?new String(bytes,StandardCharsets.UTF_8):Base64.encodeToString(bytes,Base64.NO_WRAP);
                } else {
                    File f=dataFile(a.getString(0));
                    if(op.equals("exists")) value=f.exists();
                    else if(op.equals("read")) value=new String(readAll(new FileInputStream(f)),StandardCharsets.UTF_8);
                    else if(op.equals("write") || op.equals("append")) {
                        f.getParentFile().mkdirs();
                        if(op.equals("append") && f.length()>1024*1024) { try(FileOutputStream reset=new FileOutputStream(f)) { reset.getFD().sync(); } }
                        try(FileOutputStream out=new FileOutputStream(f,op.equals("append"))) { out.write(a.getString(1).getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
                    } else if(op.equals("rename")) android.system.Os.rename(f.getAbsolutePath(),dataFile(a.getString(1)).getAbsolutePath());
                    else throw new IOException("Unsupported operation");
                }
                result.put("ok",true).put("value",value);
            } catch(Exception e) { try { result.put("ok",false).put("error","本地存储或加密操作失败："+e.getClass().getSimpleName()); } catch(JSONException ignored) {} }
            return result.toString();
        }
        @JavascriptInterface public void timer(int id, long delay) { post(()->{
            Runnable old=timers.remove(id); if(old!=null) main.removeCallbacks(old);
            Runnable r=()->{ timers.remove(id); if(epoch==generation) eval("androidTimer("+id+")"); }; timers.put(id,r); main.postDelayed(r,Math.max(1,delay));
        }); }
        @JavascriptInterface public void cancelTimer(int id) { post(()->{ Runnable r=timers.remove(id); if(r!=null) main.removeCallbacks(r); }); }
        @JavascriptInterface public void apiResult(int id,int code,String body) { post(()->{ Reply r=replies.remove(id); if(r!=null) r.done(code,body); }); }
        @JavascriptInterface public void request(int id,String url,String options) {
            network.execute(()->{
                JSONObject result=new JSONObject(); HttpURLConnection conn=null;
                try {
                    if(epoch!=generation) throw new IOException("引擎已重启");
                    if(demo) throw new IOException("演示模式禁止联网");
                    URI uri=new URI(url);
                    if(!"https".equals(uri.getScheme()) || !"libzw.csu.edu.cn".equals(uri.getHost()) || (uri.getPort()!=-1 && uri.getPort()!=443) || uri.getUserInfo()!=null) throw new IOException("不允许访问此地址");
                    JSONObject opts=new JSONObject(options); String method=opts.optString("method","GET");
                    if(!method.equals("POST") && !method.equals("GET")) throw new IOException("Invalid method");
                    conn=(HttpURLConnection)new URL(url).openConnection(); requests.put(epoch+":"+id,conn);
                    conn.setInstanceFollowRedirects(false); conn.setConnectTimeout(10000); conn.setReadTimeout(10000); conn.setRequestMethod(method);
                    JSONObject headers=opts.optJSONObject("headers"); if(headers!=null) { Iterator<String> keys=headers.keys(); while(keys.hasNext()) { String key=keys.next(); conn.setRequestProperty(key,headers.getString(key)); } }
                    if(method.equals("POST")) { byte[] bytes=opts.optString("body","{}").getBytes(StandardCharsets.UTF_8); conn.setDoOutput(true); conn.setFixedLengthStreamingMode(bytes.length); try(OutputStream out=conn.getOutputStream()) { out.write(bytes); } }
                    int status=conn.getResponseCode(); InputStream input=status>=400?conn.getErrorStream():conn.getInputStream();
                    result.put("status",status).put("body",input==null?"":new String(readAll(input),StandardCharsets.UTF_8));
                } catch(Exception e) { try { result.put("error","network 请求失败："+e.getClass().getSimpleName()); } catch(JSONException ignored) {} }
                finally { if(conn!=null) conn.disconnect(); requests.remove(epoch+":"+id); }
                String json=result.toString(); post(()->eval("androidNetworkResult("+id+","+json+")"));
            });
        }
        @JavascriptInterface public void cancelRequest(int id) { HttpURLConnection c=requests.remove(epoch+":"+id); if(c!=null) network.execute(c::disconnect); }
        @JavascriptInterface public void loginStart(boolean silent) { loginToken=""; loginError=""; post(()->startLogin(silent)); }
        @JavascriptInterface public void loginClose() { loginToken=""; post(()->closeLogin()); }
        @JavascriptInterface public String loginRead() { return "{\"token\":"+JSONObject.quote(loginToken)+",\"error\":"+JSONObject.quote(loginError)+"}"; }
        @JavascriptInterface public void status(String body) { post(()->{
            try {
                JSONObject s=new JSONObject(body); boolean wasRunning=running;
                running=s.optBoolean("running"); pendingBooking=!s.isNull("pendingBooking"); checkingBooking=s.optBoolean("checkingBooking");
                JSONObject renewal=s.optJSONObject("renewal"), management=s.optJSONObject("bookingManagement");
                renewing=renewal!=null && (renewal.optBoolean("active") || renewal.optBoolean("busy"));
                boolean working=running || checkingBooking || renewing || (management!=null && management.optBoolean("busy"));
                if(working && !foreground) {
                    try { enterForeground(); }
                    catch(Exception e) { dispatch("/api/stop","POST","{}",(c,b)->{}); notifyText("后台任务未启动","请回到应用，允许后台运行后重试。",3); }
                }
                if(foreground && working) {
                    String text=renewing ? "定时重约 · 每 "+renewal.optInt("intervalMinutes",50)+" 分钟 · 可在此停止" : "正在检查座位，可点击返回应用";
                    if(!text.equals(taskText)) { taskText=text; getSystemService(NotificationManager.class).notify(1,taskNotice(text)); }
                }
                if(foreground && !working && System.currentTimeMillis()-foregroundSince>2500) { leaveForeground(); taskText=""; }
                if(wasRunning && !running && pendingBooking) notifyText("预约结果待确认", "已暂停抢座，请打开应用核实，避免重复预约。", 3);
                else if(wasRunning && !running && !s.optBoolean("success")) notifyText("座位任务已停止", "请打开应用查看运行记录。", 3);
            } catch(JSONException ignored) {}
        }); }
        @JavascriptInterface public void renewalNotice(String body) { post(()->{
            try {
                JSONObject n=new JSONObject(body); String id=n.optString("id");
                android.content.SharedPreferences prefs=getSharedPreferences("mobile",MODE_PRIVATE);
                String key=demo?"demoRenewalNotice":"realRenewalNotice";
                if(!id.isEmpty() && !id.equals(prefs.getString(key,"")) && notificationsAllowed()) {
                    notifyText(n.optString("title"),n.optString("message"),4); prefs.edit().putString(key,id).apply();
                }
            } catch(JSONException ignored) {}
        }); }
        @JavascriptInterface public void bookingNotice(String body) { post(()->{
            try { JSONObject b=new JSONObject(body); notifyText(demo?"演示预约成功（模拟）":"抢到座位了！", b.optString("seat")+" · "+b.optString("area")+"\n"+b.optString("date")+" "+b.optString("startTime")+"–"+b.optString("endTime"),2); } catch(JSONException ignored) {}
        }); }
    }
}

