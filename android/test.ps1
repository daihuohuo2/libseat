param([string]$Sdk=$env:ANDROID_HOME,[string]$Java=$env:JAVA_HOME,[string]$Serial='emulator-5554')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
if ($Serial -notmatch '^emulator-\d+$') { throw 'These tests reset demo data: run only on a disposable emulator.' }
function Check-Step { if ($LASTEXITCODE -ne 0) { throw "Test command failed: $LASTEXITCODE" } }
$bt=Get-ChildItem "$Sdk/build-tools" -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$platform=Get-ChildItem "$Sdk/platforms" -Directory | Where-Object Name -Match '^android-\d+$' | Sort-Object { [int]($_.Name -replace 'android-','') } -Descending | Select-Object -First 1
$jar=Join-Path $platform.FullName 'android.jar'
New-Item -ItemType Directory -Force build/test-classes,build/test-dex | Out-Null
& "$Java/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath "$jar;build/classes.jar" -d build/test-classes tests/FlowTest.java
Check-Step
& "$Java/bin/jar.exe" cf build/test-classes.jar -C build/test-classes .
Check-Step
& "$Java/bin/java.exe" -cp "$($bt.FullName)/lib/d8.jar" com.android.tools.r8.D8 --min-api 26 --lib $jar --classpath build/classes.jar --output build/test-dex build/test-classes.jar
Check-Step
& "$($bt.FullName)/aapt2.exe" link -o build/test-base.apk --manifest tests/AndroidManifest.xml -I $jar
Check-Step
& "$Java/bin/jar.exe" uf build/test-base.apk -C build/test-dex classes.dex
Check-Step
& "$($bt.FullName)/zipalign.exe" -f 4 build/test-base.apk build/test-aligned.apk
Check-Step
& "$Java/bin/java.exe" -jar "$($bt.FullName)/lib/apksigner.jar" sign --ks local-debug.keystore --ks-pass pass:android --key-pass pass:android --out build/test.apk build/test-aligned.apk
Check-Step
$adb="$Sdk/platform-tools/adb.exe"
$booted=$false
for($attempt=0;$attempt -lt 60;$attempt++) {
    $boot=& $adb -s $Serial shell getprop sys.boot_completed 2>$null
    if($boot -match '1') { $booted=$true; break }
    Start-Sleep -Seconds 1
}
if(-not $booted) { throw 'Start the disposable emulator and wait for Android to finish booting.' }
& $adb -s $Serial install -r output/seat-assistant-0.2.1.apk
Check-Step
& $adb -s $Serial install -r build/test.apk
Check-Step
& $adb -s $Serial shell pm grant cn.libseat.mobile android.permission.POST_NOTIFICATIONS
Check-Step
$result = & $adb -s $Serial shell am instrument -w cn.libseat.mobile.test/cn.libseat.mobile.FlowTest
Check-Step
$result
if (($result -join "`n") -notmatch 'PASS: Android WebView') { throw 'Android flow test failed' }
