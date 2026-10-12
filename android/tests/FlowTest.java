package cn.libseat.mobile;

import android.app.*;
import android.content.*;
import android.os.*;
import android.webkit.WebView;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

// Separate instrumentation APK. Resets only demo data on a disposable emulator.
// The shipping application includes neither these controls nor this clock.
public class FlowTest extends Instrumentation {
    MainActivity activity;
    WebView page, engine;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    static void check(boolean condition,String message) { if(!condition) throw new AssertionError(message); }
    Object js(WebView view,String expression) throws Exception {
        CountDownLatch latch=new CountDownLatch(1); String[] result={null};
        runOnMainSync(()->view.evaluateJavascript(expression,v->{result[0]=v;latch.countDown();}));
        check(latch.await(8,TimeUnit.SECONDS),"JS callback timeout");
        return result[0]==null ? JSONObject.NULL : new JSONTokener(result[0]).nextValue();
    }
    void until(WebView view,String expression) throws Exception {
        for(int i=0;i<150;i++) { if(Boolean.TRUE.equals(js(view,expression))) return; Thread.sleep(100); }
        throw new AssertionError("Timeout: "+expression+"; UI: "+js(page,"document.body.innerText.slice(-1400)"));
    }
    Object promise(WebView view,String expression) throws Exception {
        js(view,"window.__flow=null; Promise.resolve().then(()=>"+expression+").then(r=>window.__flow=JSON.stringify({result:r}),e=>window.__flow=JSON.stringify({error:e.message}));true;");
        until(view,"typeof window.__flow==='string'");
        JSONObject value=new JSONObject((String)js(view,"window.__flow"));
        check(!value.has("error"),value.toString()); return value.opt("result");
    }
    JSONObject api(String route,String body) throws Exception {
        return (JSONObject)promise(page,"api("+JSONObject.quote(route)+(body==null?"":","+body)+")");
    }
    void closeDialogs() throws Exception { js(page,"document.querySelectorAll('dialog[open]').forEach(d=>d.close());true"); }
    void click(String id) throws Exception {
        until(page,"(()=>{const b=document.getElementById("+JSONObject.quote(id)+");if(!b||b.disabled||b.hidden)return false;b.click();return true;})()");
    }
    void screenshot(String name) throws Exception {
        android.graphics.Bitmap image=getUiAutomation().takeScreenshot();
        if(image!=null) try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getExternalFilesDir(null),name))) { image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out); }
    }
    void book() throws Exception {
        closeDialogs(); until(page,"!document.getElementById('btnStart').disabled");
        js(page,"document.querySelector('.mobile-selection').open=true;true");
        js(page,"document.getElementById('verifyOnly').checked=false;true"); click("btnStart");
        until(page,"document.getElementById('bookingDialog').open && document.querySelectorAll('#mapSeats .seat-mine').length===1");
        until(page,"!document.getElementById('bookingAction-cancel').hidden && !document.getElementById('bookingAction-cancel').disabled");
    }
    void writeDemo(String name,String text) throws Exception {
        File demo=new File(getTargetContext().getFilesDir(),"demo"); demo.mkdirs();
        try(FileOutputStream out=new FileOutputStream(new File(demo,name))) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
    }
    @Override public void onStart() {
        Bundle result=new Bundle();
        try {
            getTargetContext().getSharedPreferences("mobile",Context.MODE_PRIVATE).edit().putBoolean("demo",true).commit();
            writeDemo("config.json","{\"token\":\"android-demo\",\"dateMode\":\"today\",\"timeMode\":\"now\",\"verifyOnly\":false,\"autoRefresh\":false,\"areaIds\":[\"59\"],\"preferAreas\":[\"59\"]}");
            writeDemo("bookings.json","{\"version\":1,\"pending\":null,\"history\":[],\"claims\":[]}");
            writeDemo("renewal.json","{\"version\":1,\"job\":null}"); writeDemo("demo-records.json","[]");
            activity=(MainActivity)startActivitySync(new Intent(getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            for(int i=0;i<150 && (activity.service==null || !activity.service.ready || activity.ui==null);i++) Thread.sleep(100);
            check(activity.service!=null && activity.service.ready,"engine must initialize without storage/bridge errors");
            page=activity.ui; engine=activity.service.engine;
            until(page,"document.readyState==='complete' && typeof loadConfig==='function' && !!document.getElementById('btnDemoSignIn')");
            String clock="(()=>{const RealDate=Date;window.flowNow=RealDate.parse('2026-10-10T08:00:00+08:00');window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[window.flowNow]));}static now(){return window.flowNow;}};return true;})()";
            js(engine,clock); js(page,clock);
            // Renewal captures its clock when the module starts, before the UI is ready.
            js(engine,"(()=>{const p=require('./renewal.js').Renewal.prototype,start=p.start;p.start=function(options){this.now=()=>window.flowNow;return start.call(this,options);};return true;})()");
            js(page,"window.confirm=()=>true;navigator.geolocation.getCurrentPosition=(ok,fail)=>fail({code:1});true");
            promise(page,"loadConfig().then(()=>initMapBrowser(true))");
            until(page,"document.querySelectorAll('#mapSeats .seat').length===48 && !document.getElementById('mapLoadHelp').hidden===false");
            check(Boolean.TRUE.equals(js(page,"document.documentElement.scrollWidth<=innerWidth+1")),"mobile page must fit viewport");
            book(); JSONObject first=api("/api/status",null).getJSONObject("booking"); closeDialogs();
            js(page,"document.getElementById('renewalArrival').value='14:00';document.getElementById('renewalInterval').value='30';document.getElementById('renewalInterval').dispatchEvent(new Event('input'));true");
            until(page,"!document.getElementById('btnRenewalStart').disabled"); click("btnRenewalStart");
            until(page,"document.getElementById('renewalState').textContent==='计时中'");
            Thread.sleep(3500); check(activity.service.foreground && activity.service.renewing,"renewal must retain foreground service and wake lock");
            check(api("/api/status",null).getJSONObject("renewal").getInt("intervalMinutes")==30,"slider must reach native engine");
            check(Boolean.FALSE.equals(js(page,"document.querySelector('.mobile-selection').open")),"successful booking collapses selection controls");
            js(page,"document.querySelector('.renewal-panel').scrollIntoView({block:'start'});true"); Thread.sleep(250); screenshot("mobile-renewal.png");
            js(engine,"window.flowNow+=30*60000+5000;true"); js(page,"window.flowNow+=30*60000+5000;true");
            for(int i=0;i<120 && api("/api/status",null).getJSONObject("renewal").optInt("cycles")<1;i++) Thread.sleep(100);
            JSONObject status=api("/api/status",null);
            check(status.getJSONObject("renewal").getInt("cycles")==1,status.toString());
            check(!first.getString("id").equals(status.getJSONObject("booking").getString("id")),"renewal must create new identity");
            check(first.getString("seat").equals(status.getJSONObject("booking").getString("seat")),"renewal keeps the same seat");
            until(page,"mapBookingStatus?.booking?.id==="+JSONObject.quote(status.getJSONObject("booking").getString("id"))+" && !tickPending");
            closeDialogs(); click("btnBookingDetails");
            until(page,"!document.getElementById('bookingAction-cancel').disabled && !document.getElementById('bookingAction-cancel').hidden"); click("bookingAction-cancel");
            until(page,"document.getElementById('bookingStatus').textContent==='已取消预约'");
            until(page,"document.getElementById('bookingSummary').hidden");
            status=api("/api/status",null); check(!status.getBoolean("success") && !status.getJSONObject("renewal").getBoolean("active"),"manual cancel must stop renewal and release seat");
            until(page,"document.querySelectorAll('#mapSeats .seat-mine').length===0");
            book(); closeDialogs(); click("btnDemoSignIn");
            until(page,"document.getElementById('btnBookingDetails').textContent==='查看位置信息'"); click("btnBookingDetails");
            until(page,"!document.getElementById('bookingAction-leave').hidden && !document.getElementById('bookingAction-leave').disabled"); click("bookingAction-leave");
            until(page,"document.getElementById('bookingStatus').textContent==='临时签离中'");
            check(api("/api/status",null).getBoolean("success"),"temporary leave keeps seat");
            until(page,"!document.getElementById('bookingAction-checkout').disabled"); click("bookingAction-checkout");
            until(page,"document.getElementById('bookingStatus').textContent==='已结束使用'");
            check(!api("/api/status",null).getBoolean("success"),"full checkout releases seat");
            until(page,"document.querySelectorAll('#mapSeats .seat-mine').length===0");
            closeDialogs(); click("btnHelp"); until(page,"document.getElementById('helpDialog').open");
            check(Boolean.TRUE.equals(js(page,"document.getElementById('helpDialog').getBoundingClientRect().width<=innerWidth")),"help fits mobile viewport");
            closeDialogs();
            // Login double and changing seat responses live only in the separate test APK.
            js(engine,"Object.assign(require('./browser-login.js'),{launchBrowser(){},async closeBrowser(){},async waitForToken(){return {ok:true,token:'android-demo-refreshed'};}});window.testFree=true;(()=>{const m=require('./android-demo.js'),respond=m.respond;m.respond=function(p,b){const r=respond(p,b);if(p==='/v4/Space/seat')r.data.list[1].status=window.testFree?'1':'6';return r;};})();true");
            api("/api/auto-login","{\"headlessFirst\":false}");
            until(page,"lastLoginGeneration===1 && !fullRefreshPromise && document.querySelector('#mapSeats [data-no=XF5A002]').classList.contains('seat-available')");
            js(engine,"window.testFree=false;true"); click("btnMapRefresh");
            until(page,"!fullRefreshPromise && document.querySelector('#mapSeats [data-no=XF5A002]').classList.contains('seat-occupied')");
            book(); closeDialogs();
            js(engine,"window.flowNow=Date.parse('2026-10-11T08:00:00+08:00');true");
            js(page,"window.flowNow=Date.parse('2026-10-11T08:00:00+08:00');lastResumeRefresh=0;true");
            runOnMainSync(()->{activity.onPause();activity.onResume();});
            until(page,"!fullRefreshPromise && document.getElementById('bookingSummary').hidden && document.getElementById('btnMySeat').hidden && lastMapData?.date==='2026-10-11'");
            check(!api("/api/status",null).getBoolean("success"),"next-day resume clears expired success");
            check(api("/api/bookings",null).getJSONArray("history").getJSONObject(0).getString("outcome").equals("completed"),"expired reservation remains in history");
            check(Boolean.TRUE.equals(js(page,"document.querySelectorAll('#mapSeats .seat-mine').length===0 && getComputedStyle(document.getElementById('bookingSummary')).display==='none'")),"old booking banner and red seat must disappear");
            check(Boolean.TRUE.equals(js(page,"document.getElementById('renewalTiming').textContent==='' && document.getElementById('renewalStatus').textContent==='' && document.getElementById('renewalEvents').textContent!=='暂无记录。'")),"stopped previous renewal is visible only in its history");
            screenshot("mobile-refresh.png");
            book(); check(api("/api/status",null).getJSONObject("booking").getString("date").equals("2026-10-11"),"can book again the following morning");
            result.putString("stream","PASS: Android WebView map, grab, renewal, cancel, sign/leave/checkout, login refresh, manual refresh, next-day native resume, retained history and new booking.\n");
            finish(Activity.RESULT_OK,result);
        } catch(Throwable e) { result.putString("stream","FAIL: "+android.util.Log.getStackTraceString(e)); finish(Activity.RESULT_CANCELED,result); }
    }
}
