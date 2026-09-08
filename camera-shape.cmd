@echo off
REM Double-click this file. It asks SpyPoint what your cameras send, and
REM writes a REDACTED dump of their field shape to spypoint-data\shape.txt,
REM safe to hand to someone helping with a camera that came through blank.
REM
REM -ExecutionPolicy Bypass applies to this one run only. It does not change
REM any setting on your machine, and is here because Windows blocks unsigned
REM .ps1 files by default.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Get-CameraShape.ps1"
