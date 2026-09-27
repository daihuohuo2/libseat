param([string]$Device='emulator-5554')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
if ($Device -notlike 'emulator-*') { throw 'Offline smoke tests are restricted to an emulator.' }
$sdkDir=$env:ANDROID_HOME
$javaDir=$env:JAVA_HOME
$testTools=(Get-ChildItem "$sdkDir/build-tools" -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
$testPlatform=(Get-ChildItem "$sdkDir/platforms" -Directory | Where-Object Name -Match '^android-\d+$' | Sort-Object { [int]($_.Name -replace 'android-','') } -Descending | Select-Object -First 1).FullName
function Check-TestStep { if($LASTEXITCODE -ne 0) { throw "Test command failed: $LASTEXITCODE" } }
New-Item -ItemType Directory -Force build/test-classes,build/test-dex | Out-Null
& "$testTools/aapt2.exe" link -o build/test-base.apk --manifest tests/AndroidManifest.xml -I "$testPlatform/android.jar"
Check-TestStep
& "$javaDir/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath "$testPlatform/android.jar;build/classes.jar" -d build/test-classes tests/SmokeTest.java
Check-TestStep
& "$javaDir/bin/jar.exe" cf build/test-classes.jar -C build/test-classes .
Check-TestStep
& "$javaDir/bin/java.exe" -cp "$testTools/lib/d8.jar" com.android.tools.r8.D8 --min-api 26 --lib "$testPlatform/android.jar" --classpath build/classes.jar --output build/test-dex build/test-classes.jar
Check-TestStep
Copy-Item build/test-base.apk build/test-unsigned.apk -Force
& "$javaDir/bin/jar.exe" uf build/test-unsigned.apk -C build/test-dex classes.dex
Check-TestStep
& "$testTools/zipalign.exe" -f 4 build/test-unsigned.apk build/test-aligned.apk
Check-TestStep
& "$javaDir/bin/java.exe" -jar "$testTools/lib/apksigner.jar" sign --ks local-debug.keystore --ks-pass pass:android --out build/test.apk build/test-aligned.apk
Check-TestStep
& "$sdkDir/platform-tools/adb.exe" -s $Device install -r output/seat-assistant-0.1.0.apk
Check-TestStep
& "$sdkDir/platform-tools/adb.exe" -s $Device install -r build/test.apk
Check-TestStep
& "$sdkDir/platform-tools/adb.exe" -s $Device shell pm grant cn.libseat.mobile android.permission.POST_NOTIFICATIONS
& "$sdkDir/platform-tools/adb.exe" -s $Device shell am force-stop cn.libseat.mobile
& "$sdkDir/platform-tools/adb.exe" -s $Device shell am instrument -w cn.libseat.mobile.tests/cn.libseat.mobile.SmokeTest | Tee-Object build/smoke-results.txt
Check-TestStep
if(-not (Select-String -Path build/smoke-results.txt -Pattern 'ALL PASSED' -Quiet)) { throw 'Android smoke test failed.' }
New-Item -ItemType Directory -Force build/screenshots | Out-Null
foreach($shot in @('android-demo-home','android-demo-plans','android-demo-success','android-real-home')) {
  & "$sdkDir/platform-tools/adb.exe" -s $Device pull "/sdcard/Android/data/cn.libseat.mobile/files/$shot.png" "build/screenshots/$shot.png"
  Check-TestStep
}
