param([string]$Sdk = $env:ANDROID_HOME, [string]$Java = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $Sdk) { throw 'Set ANDROID_HOME to your Android SDK directory.' }
if (-not (Test-Path "$Java/bin/javac.exe")) { $Java = Split-Path (Split-Path (Get-Command javac.exe).Source) }
$sdkTools = Get-ChildItem "$Sdk/build-tools" -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$platform = Get-ChildItem "$Sdk/platforms" -Directory | Where-Object Name -Match '^android-\d+$' | Sort-Object { [int]($_.Name -replace 'android-','') } -Descending | Select-Object -First 1
$androidJar = Join-Path $platform.FullName 'android.jar'
$buildDir = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force "$buildDir/classes", "$buildDir/dex", "$buildDir/gen", "$PSScriptRoot/output" | Out-Null
function Check-Step { if ($LASTEXITCODE -ne 0) { throw "Build command failed: $LASTEXITCODE" } }
& node "$PSScriptRoot/prepare-assets.js"
Check-Step
& "$($sdkTools.FullName)/aapt2.exe" compile --dir res -o 'build/resources.zip'
Check-Step
& "$($sdkTools.FullName)/aapt2.exe" link -o 'build/base.apk' --manifest AndroidManifest.xml -I $androidJar -R 'build/resources.zip' -A 'build/assets' --java 'build/gen' --auto-add-overlay
Check-Step
$sources = @(Get-ChildItem src, "$buildDir/gen" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
& "$Java/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d "$buildDir/classes" $sources
Check-Step
& "$Java/bin/jar.exe" cf "$buildDir/classes.jar" -C "$buildDir/classes" .
Check-Step
& "$Java/bin/java.exe" -cp "$($sdkTools.FullName)/lib/d8.jar" com.android.tools.r8.D8 --min-api 26 --lib $androidJar --output "$buildDir/dex" "$buildDir/classes.jar"
Check-Step
Copy-Item "$buildDir/base.apk" "$buildDir/unsigned.apk" -Force
& "$Java/bin/jar.exe" uf "$buildDir/unsigned.apk" -C "$buildDir/dex" classes.dex
Check-Step
& "$($sdkTools.FullName)/zipalign.exe" -f 4 'build/unsigned.apk' 'build/aligned.apk'
Check-Step
$keyFile = Join-Path $PSScriptRoot 'local-debug.keystore'
if (-not (Test-Path $keyFile)) {
  & "$Java/bin/keytool.exe" -genkeypair -keystore $keyFile -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Libseat Prototype,O=Local,C=CN'
  Check-Step
}
$apkFile = Join-Path $PSScriptRoot 'output/seat-assistant-0.1.0.apk'
& "$Java/bin/java.exe" -jar "$($sdkTools.FullName)/lib/apksigner.jar" sign --ks $keyFile --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out $apkFile "$buildDir/aligned.apk"
Check-Step
& "$Java/bin/java.exe" -jar "$($sdkTools.FullName)/lib/apksigner.jar" verify --verbose $apkFile
Check-Step
Get-FileHash $apkFile -Algorithm SHA256
Write-Host "APK ready: $apkFile"
