package cn.libseat.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import android.graphics.Bitmap;
import org.json.*;
import java.io.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Separate signed instrumentation APK. Never installed on the user's phone. */
public class SmokeTest extends Instrumentation {
    MainActivity activity;
    final StringBuilder report=new StringBuilder();
    @Override public void onCreate(Bundle b) { super.onCreate(b); start(); }
    interface Condition { boolean test() throws Exception; }
    void waitFor(String label,Condition c) throws Exception {
        long deadline=System.currentTimeMillis()+20000;
        while(System.currentTimeMillis()<deadline) { if(c.test()) return; Thread.sleep(200); }
        throw new AssertionError("Timed out: "+label);
    }
    void check(boolean condition,String label) { if(!condition) throw new AssertionError(label); report.append("PASS ").append(label).append('\n'); Bundle b=new Bundle(); b.putString("stream","PASS "+label+"\n"); sendStatus(0,b); }
    String js(String expression) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        runOnMainSync(()->activity.ui.evaluateJavascript(expression,r->{value.set(r);done.countDown();}));
        if(!done.await(5,TimeUnit.SECONDS)) throw new AssertionError("UI JS timeout"); return value.get();
    }
    JSONObject api(String path,String method,String body) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        runOnMainSync(()->activity.service.dispatch(path,method,body,(c,r)->{value.set(r);done.countDown();}));
        if(!done.await(20,TimeUnit.SECONDS)) throw new AssertionError("API timeout: "+path);
        return new JSONObject(value.get());
    }
    void shot(String name) throws Exception { Thread.sleep(400); Bitmap bitmap=getUiAutomation().takeScreenshot(); try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getExternalFilesDir(null),name+".png"))) { bitmap.compress(Bitmap.CompressFormat.PNG,100,out); } }
    @Override public void onStart() {
        Bundle result=new Bundle();
        try {
            // Only known demo files belonging to this app on the test emulator.
            new File(getTargetContext().getFilesDir(),"demo/bookings.json").delete();
            new File(getTargetContext().getFilesDir(),"demo/config.json").delete();
            getTargetContext().getSystemService(NotificationManager.class).cancelAll();
            getTargetContext().getSharedPreferences("mobile",0).edit().putBoolean("demo",true).commit();
            activity=(MainActivity)startActivitySync(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor("service",()->activity.service!=null && activity.service.ready && activity.ui!=null);
            waitFor("map",()->"true".equals(js("typeof lastMapData!=='undefined' && lastMapData?.seats?.length===48")));
            check("true".equals(js("document.body.innerText.includes('演示模式')")),"demo label visible");
            check("true".equals(js("document.documentElement.scrollWidth<=window.innerWidth+1")),"phone layout has no horizontal overflow");
            check(api("/api/seats","POST","{\"areaId\":\"59\"}").getJSONArray("seats").length()==48,"native API bridge returns 48 demo seats");
            shot("android-demo-home");
            js("$('tab-plans').click()"); check("false".equals(js("$('plansPanel').hidden")),"plans tab opens");
            shot("android-demo-plans"); js("$('tab-booking').click()");
            File imported=new File(getTargetContext().getCacheDir(),"smoke-plans.json");
            try(FileOutputStream out=new FileOutputStream(imported)) { out.write("{\"app\":\"libseat\",\"plans\":[{\"name\":\"Imported test plan\",\"areas\":[\"57\"]}]}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            runOnMainSync(()->activity.onActivityResult(12,Activity.RESULT_OK,new Intent().setData(android.net.Uri.fromFile(imported))));
            waitFor("import",()->api("/api/config","GET","{}").getJSONObject("config").getJSONArray("seatPlans").length()==2);
            check(true,"native file import saves a plan");
            check(api("/api/config","POST","{\"verifyOnly\":true,\"maxAttempts\":0,\"interval\":1}").getBoolean("ok"),"config stored on device");
            runOnMainSync(()->activity.service.enterForeground());
            check(api("/api/start","POST","{\"verifyOnly\":true,\"interval\":1,\"dateMode\":\"tomorrow\",\"timeMode\":\"custom\",\"startTime\":\"08:00\",\"endTime\":\"10:00\"}").getBoolean("ok"),"observation task starts");
            waitFor("first query",()->api("/api/status","GET","{}").optLong("lastCheck")>0);
            long first=api("/api/status","GET","{}").getLong("lastCheck");
            runOnMainSync(()->activity.moveTaskToBack(true)); Thread.sleep(3200);
            JSONObject background=api("/api/status","GET","{}");
            check(background.getBoolean("running") && background.getLong("lastCheck")>first,"engine keeps polling with UI in background");
            check(activity.service.foreground,"task has foreground service");
            getTargetContext().startService(new Intent(getTargetContext(),EngineService.class).setAction("STOP"));
            waitFor("stop",()->!api("/api/status","GET","{}").getBoolean("running"));
            check(true,"notification stop action stops engine");
            waitFor("foreground released",()->!activity.service.foreground);
            getTargetContext().startActivity(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP));
            Thread.sleep(1000);
            runOnMainSync(()->activity.service.enterForeground());
            check(api("/api/start","POST","{\"verifyOnly\":false,\"interval\":1,\"dateMode\":\"tomorrow\",\"timeMode\":\"custom\",\"startTime\":\"08:00\",\"endTime\":\"10:00\"}").getBoolean("ok"),"simulated booking starts");
            waitFor("success",()->api("/api/status","GET","{}").optBoolean("success"));
            JSONObject success=api("/api/status","GET","{}");
            check(!success.getBoolean("running") && success.isNull("pendingBooking"),"successful booking stops and clears pending");
            check(api("/api/bookings","GET","{}").getJSONArray("history").length()>0,"booking persisted to history");
            waitFor("native success notification",()->java.util.Arrays.stream(getTargetContext().getSystemService(NotificationManager.class).getActiveNotifications()).anyMatch(n->n.getId()==2));
            check(true,"Android system receives success notification");
            String id=success.getJSONObject("booking").getString("id");
            api("/api/notification-claim","POST","{\"id\":\""+id+"\",\"channel\":\"desktop\"}");
            check(!api("/api/notification-claim","POST","{\"id\":\""+id+"\",\"channel\":\"desktop\"}").getBoolean("claimed"),"notification is deduplicated");
            waitFor("success dialog",()->"true".equals(js("$('bookingDialog').open")));
            shot("android-demo-success"); js("$('bookingDialog').close()");
            // Real-mode storage must remain empty, without a demo token or history.
            runOnMainSync(()->activity.service.switchMode(false,()->activity.loadUi()));
            waitFor("real mode",()->activity.service.ready && !activity.service.demo);
            check(!api("/api/config","GET","{}").getJSONObject("config").has("tokenMask"),"real mode does not inherit demo credentials");
            check(api("/api/bookings","GET","{}").getJSONArray("history").length()==0,"real and demo histories are isolated");
            waitFor("real UI",()->"true".equals(js("document.body.innerText.includes('安卓体验版')")));
            shot("android-real-home");
            EngineService.NativeBridge bridge=activity.service.new NativeBridge(activity.service.generation);
            String vector="{\"op\":\"aes\",\"args\":[false,\"2026092772906202\",\"ZZWBKJ_ZHIHUAWEI\",\"{\\\"seat_id\\\":\\\"test\\\"}\"]}";
            JSONObject encrypted=new JSONObject(bridge.sync(vector));
            check(encrypted.getBoolean("ok"),"native AES encryption works");
            JSONObject decrypted=new JSONObject(bridge.sync(new JSONObject().put("op","aes").put("args",new JSONArray().put(true).put("2026092772906202").put("ZZWBKJ_ZHIHUAWEI").put(encrypted.getString("value"))).toString()));
            check("{\"seat_id\":\"test\"}".equals(decrypted.getString("value")),"native AES round-trip preserves payload");
            check(!new JSONObject(bridge.sync("{\"op\":\"read\",\"args\":[\"/data/../secret\"]}")).getBoolean("ok"),"native storage rejects traversal");
            // Open only the unauthenticated school page, then exercise cancellation. No credentials or orders.
            check(api("/api/auto-login","POST","{\"headlessFirst\":false}").getBoolean("ok"),"manual login requested");
            waitFor("login page",()->activity.service.login!=null && activity.loginBox!=null);
            check(activity.service.login!=activity.ui,"school login uses separate unprivileged WebView");
            runOnMainSync(()->{ activity.service.loginError="测试取消登录"; activity.service.closeLogin(); });
            waitFor("login cancellation",()->!api("/api/login-status","GET","{}").getBoolean("active"));
            check(!api("/api/config","GET","{}").getJSONObject("config").has("tokenMask"),"cancelled login does not save a token");
            runOnMainSync(()->activity.service.switchMode(true,()->activity.loadUi()));
            waitFor("demo restored",()->activity.service.ready && activity.service.demo);
            check(api("/api/bookings","GET","{}").getJSONArray("history").length()>0,"history survives engine restart");
            result.putString("stream",report.toString()+"ALL PASSED\n"); finish(Activity.RESULT_OK,result);
        } catch(Throwable e) { result.putString("stream",report.toString()+"FAILED: "+e+"\n"+android.util.Log.getStackTraceString(e)); finish(Activity.RESULT_CANCELED,result); }
    }
}
