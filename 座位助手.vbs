' LibSeat launcher (Edge app-mode).
' ASCII-only on purpose: avoids codepage issues in Windows Script Host.
' Starts launcher.js hidden; it handles server start, app window, and cleanup.
Option Explicit
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
sh.Run "node """ & root & "\launcher.js""", 0, False
