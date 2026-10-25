@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Qingframe dev launcher.
rem
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd parses .bat bytes using the console codepage. A UTF-8 Chinese
rem  .bat gets read as GBK, a double-byte lead byte then swallows the
rem  following character, and the rest of the line is executed as a
rem  command. We hit exactly that:
rem      '<chinese word>' is not recognized as an internal or external command
rem  Chinese messages therefore come from Node (src/main/index.js), which
rem  prints correctly because chcp 65001 is set above.
rem  Consequence: never grep the log for the Chinese single-instance
rem  message - grep for the ASCII markers only.
rem
rem  WHY software GL is the default
rem  -----------------------------
rem  The hardware path dies at startup on this machine with exit code
rem  -2147483645 == 0x80000003 == STATUS_BREAKPOINT. Chromium raises that
rem  from LOG(FATAL) via __debugbreak when the GPU process cannot be used,
rem  so the whole app dies before the renderer starts and start.log ends up
rem  with no Electron output at all (the crash lands before stderr flushes).
rem
rem  Measured here:
rem    electron .                                   -> STATUS_BREAKPOINT, dead
rem    electron . --disable-gpu                     -> STILL dead; Electron 31
rem       still spawns the GPU process anyway. Do not "simplify" back to it.
rem    electron . --use-gl=swiftshader --no-sandbox -> window comes up, stable.
rem
rem  THE SINGLE-INSTANCE LOCK
rem  -----------------------
rem  Chromium takes a 0-byte lock file, %APPDATA%\qingframe-web\lockfile:
rem  created on launch, deleted on exit. If it cannot create it, Chromium
rem  reports
rem      process_singleton_win.cc(465) Lock file can not be created!
rem      Error code: 5            (5 = ERROR_ACCESS_DENIED)
rem  app.requestSingleInstanceLock() then returns false, so the app prints
rem  its own "already running" warning too. That warning is a SYMPTOM, not
rem  the cause: :classify therefore tests the Chromium line FIRST and only
rem  then the app's refusal line. Testing them the other way round reports
rem  "another instance owns the lock" and skips the recovery below, which is
rem  exactly the bug this comment exists to prevent.
rem
rem  This failure is intermittent: the same command from the same account
rem  failed and then worked 31 seconds later. The profile directory is
rem  writable (a 0-byte file with the real name can be created there at any
rem  time), holds no stale lock, and no leftover electron.exe was running, so
rem  the cause is a transient handle on that lock file. Rather than guess,
rem  :recover_lock removes the stale file and retries exactly once - safe
rem  because the guard (no live electron.exe) is checked first, and safe to
rem  retry because a rejected attempt never started anything. Contrast with
rem  the GPU crash, which must NOT be retried: that process is still tearing
rem  down and its retry loses the lock race.
rem
rem  Structure notes, both learned the hard way:
rem    - each launch is its own label, not an if/else block, because a '>'
rem      inside parentheses needs no escaping and escaping it with '^'
rem      silently turns the redirect into a literal argument to npm.
rem    - each mode stores its flags in %FLAGS% and captures %errorlevel%
rem      immediately, because 'goto' is not guaranteed to preserve it.
rem    - %RETRIED% guards the single retry so :classify cannot loop.
rem
rem  MODES
rem    (default)                 hardware GPU + no-sandbox (fast path)
rem    QINGFRAME_SW=1            software GL (swiftshader) - use if the GPU path
rem                              dies with STATUS_BREAKPOINT on this machine
rem    QINGFRAME_FRESH_PROFILE=1 software GL + empty profile. Last-resort
rem                              escape hatch; saved templates and
rem                              state.json will NOT be visible there.
rem  Measured on this machine (1440x900, DPR 2), preset wall drag:
rem    hardware GPU: p50 6.1ms/frame, 0 dropped
rem    swiftshader : p50 54.7ms/frame, every frame dropped
rem  i.e. the software path is ~9x slower; only fall back to it if needed.
rem  To see the raw error that start.log swallows, run in a plain cmd window:
rem    node_modules\.bin\electron.cmd . --enable-logging
rem ============================================================

echo ============================================================
echo  Qingframe - dev launcher
echo ============================================================
echo.

set FLAGS=--no-sandbox
set LOCKDIR=%APPDATA%\qingframe-web
rem  Codex/OpenCode sandbox placed Deny ACEs on this project dir; node_modules
rem  electron.exe there gets ERROR_ACCESS_DENIED creating any file (the lock).
rem  A byte-identical copy lives outside the project; prefer it when present.
set ELECTRON_CUSTOM=%LOCALAPPDATA%\qfs-electron\dist\electron.exe

if "%QINGFRAME_SW%"=="1" goto mode_sw
if "%QINGFRAME_FRESH_PROFILE%"=="1" goto mode_fresh

echo  Mode: hardware GPU ^(fast path^)
echo.
goto launch

:mode_sw
set FLAGS=--use-gl=swiftshader --no-sandbox
echo  Mode: software GL ^(swiftshader^) - slower, but survives a broken GPU stack.
echo.
goto launch

:mode_hw
set FLAGS=--no-sandbox
echo  Mode: HARDWARE GPU ^(QINGFRAME_HW=1^) - same as the default, kept for scripts.
echo.
goto launch

:mode_fresh
set FLAGS=--use-gl=swiftshader --no-sandbox --user-data-dir="%~dp0.profile-fresh"
set LOCKDIR=%~dp0.profile-fresh
echo  Mode: software GL + FRESH profile ^(QINGFRAME_FRESH_PROFILE=1^)
echo  Escape hatch for a lock that cannot be taken at all.
echo  NOTE: saved templates and state.json live in the normal profile and
echo  will NOT be visible in this one.
echo.
goto launch

:launch
call :pick_electron
goto classify

rem  Reaching this point means the app EXITED. Had it started normally this
rem  script would still be blocked on the call above with the window open, so
rem  every message from here is a post-mortem - never "it works".
:classify
echo.
echo ------------------------------------------------------------
type "%~dp0start.log"
echo ------------------------------------------------------------
echo.

rem  CAUSE first, symptom second - see the header note.
findstr /C:"process_singleton" "%~dp0start.log" >nul 2>&1
if not errorlevel 1 goto lock_broken
findstr /C:"single-instance lock refused" "%~dp0start.log" >nul 2>&1
if not errorlevel 1 goto refused

if "%CODE%"=="0" goto closed
goto crashed

:refused
echo NOT STARTED - another instance already owns the single-instance lock.
echo   This one is expected whenever a Qingframe window is still open.
echo   Close it, or: taskkill /F /IM electron.exe
goto done

rem  The lock file could not be created. Happens on the first retry only.
:lock_broken
if "%RETRIED%"=="1" goto lock_failed

call :any_electron
if errorlevel 1 goto recover_lock

echo NOT STARTED - the lock is held by a live instance, and its lock file
echo   cannot be recreated ^(see the Chromium error above^). Close the other
echo   window first:
echo     taskkill /F /IM electron.exe
echo   The stale lock file is deliberately NOT deleted here: removing it
echo   while an instance is alive could let a second copy start beside it.
goto done

:recover_lock
echo NOT STARTED - Chromium could not create the single-instance lock file
echo   ^(the exact Windows error code is in the log above^).
echo   No electron.exe process is running, so the lock file is stale. It is a
echo   0-byte file Chromium creates on launch and deletes on exit, and
echo   removing it is safe precisely because nothing is running.
echo.
echo   --- environment this launch saw ---
echo     APPDATA     = %APPDATA%
echo     USERPROFILE = %USERPROFILE%
echo     TEMP        = %TEMP%
echo     lock dir    = %LOCKDIR%
call :probe_write
echo.
echo   Removing "%LOCKDIR%\lockfile" and trying once more...
del "%LOCKDIR%\lockfile" >nul 2>&1
ping -n 3 127.0.0.1 >nul
set RETRIED=1
call :pick_electron
goto classify

:lock_failed
echo STILL NOT STARTED - the lock file could not be created even after the
echo   stale one was removed. The block above is what to report; it pins the
echo   failing environment down.
echo.
echo   Things that would still explain it:
echo     - a third-party scanner/EDR holding a transient handle on the file.
rem       Defender is OFF on this machine, so if one is installed it is not
rem       the built-in one.
echo     - a different session (RDP, a service account, a sandbox) taking
echo       the lock somewhere other than the profile named above.
echo.
echo   Escape hatch, verified to start, but your templates and state.json
echo   will not be visible:
echo     set QINGFRAME_FRESH_PROFILE=1 ^&^& start.bat
call :show_labels
goto done

:closed
echo The app exited with code 0 without crashing.
echo   If you did not close the window yourself, another instance already had
echo   the lock - look for the single-instance line in the log above.
goto done

:crashed
echo The app CRASHED on startup with exit code %CODE%.
echo   -2147483645 ^(0x80000003 / STATUS_BREAKPOINT^) means the GPU process
echo   could not be used; use the default software GL mode instead.
echo   Any other code: read the log above. For the raw error that the
echo   redirect can swallow, run in a plain cmd window:
echo     node_modules\.bin\electron.cmd . --enable-logging
goto done

rem  Can the profile dir that must hold the lock take a new file at all?
rem  Answers the "is this just permissions" question with evidence.
rem  Launch through the project-external Electron copy when it exists (the
rem  sandbox Deny on this project breaks node_modules electron file creation),
rem  otherwise fall back to npm start.
:pick_electron
if not exist "%ELECTRON_CUSTOM%" goto pick_npm
echo  Electron: %ELECTRON_CUSTOM% ^(project-external, sandbox bypass^)
"%ELECTRON_CUSTOM%" . %FLAGS% > "%~dp0start.log" 2>&1
set CODE=%errorlevel%
exit /b 0
:pick_npm
call npm start -- %FLAGS% > "%~dp0start.log" 2>&1
set CODE=%errorlevel%
exit /b 0

rem  Can the profile dir that must hold the lock take a new file at all?
rem  Answers the "is this just permissions" question with evidence.
:probe_write
>"%LOCKDIR%\_lockprobe" echo ok
if errorlevel 1 goto probe_bad
echo     create probe = OK ^(the directory accepts new files^)
del "%LOCKDIR%\_lockprobe" >nul 2>&1
exit /b 0
:probe_bad
echo     create probe = FAILED ^(and Chromium would be right to complain^)
:probe_end
exit /b 0

rem  Returns errorlevel 0 if any electron.exe is alive, 1 if none.
:any_electron
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | find /i "electron.exe" >nul
exit /b

rem  Integrity labels are the whole story here: a lock file left behind by an
rem  ELEVATED instance carries a High mandatory label, and a Medium (normal)
rem  launch then gets ERROR_ACCESS_DENIED on it - and cannot even delete it.
rem  Double-clicking from Explorer runs Medium, so this is worth showing.
:show_labels
echo.
echo   --- integrity labels (High here = an elevated run left the file behind) ---
echo     this session is: ^(
fltmc >nul 2>&1
if errorlevel 1 echo     MEDIUM - cannot touch a High-labelled lock file^&^) else echo     ELEVATED^)
if exist "%LOCKDIR%\lockfile" goto labels_file
echo     lock file: absent
goto labels_end
:labels_file
echo     lock file: PRESENT
icacls "%LOCKDIR%\lockfile" 2>nul | find /i "mandatory" >nul
if errorlevel 1 goto labels_no_mic
icacls "%LOCKDIR%\lockfile" 2>nul | findstr /i "mandatory"
goto labels_end
:labels_no_mic
echo       no explicit mandatory label
:labels_end
exit /b 0

:done
echo.
echo Log file: %~dp0start.log
echo.
pause
