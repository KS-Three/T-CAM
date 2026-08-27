@echo off
REM Double-click this file. It runs Start-TrailCam.ps1, which syncs your
REM cameras, builds the hunt plan, and opens the dashboard in your browser.
REM
REM -ExecutionPolicy Bypass applies to this one run only. It does not change
REM any setting on your machine, and is here because Windows blocks unsigned
REM .ps1 files by default.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-TrailCam.ps1"
