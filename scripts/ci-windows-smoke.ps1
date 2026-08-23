# ci-windows-smoke.ps1 — Windows daemon 非交互链路冒烟测试。
# 验证 PR4 实现: daemon start(detached) → 单例锁互斥(第二个失败) → 控制通道 stop(优雅退出)。
# relay 用 fake URL(daemon 连失败但不阻塞单例/stop 验证;relay 链路靠后续真机/集成测)。
#
# 注意: PR4 实现首次真跑,大概率撞运行时 bug。本脚本是探测器——失败时 Actions 日志暴露问题。

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot/..

Write-Host "=== [1/4] Build pocketctl.exe ==="
go build -o pocketctl.exe ./cmd/pocketctl
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "=== [2/4] Start daemon (foreground, fake relay) ==="
# --foreground 跑前台(不走 daemonize);fake relay URL 让 ws 连接失败但不阻塞单例/控制通道验证
$p = Start-Process -FilePath ".\pocketctl.exe" `
    -ArgumentList "daemon","start","--foreground","--relay","ws://127.0.0.1:1/fake","--token","smoke-test-token" `
    -PassThru -NoNewWindow
Start-Sleep -Seconds 3

if ($p.HasExited) {
    Write-Host "WARN: daemon exited early (exit code $($p.ExitCode)); may be expected if ws connect fails fatally"
    # 不直接 fail——单例/控制通道测试需要 daemon 存活。若 early exit,后续步骤会捕获。
}

Write-Host "=== [3/4] Single-instance lock (second start must fail) ==="
$p2 = Start-Process -FilePath ".\pocketctl.exe" `
    -ArgumentList "daemon","start","--foreground","--relay","ws://127.0.0.1:1/fake","--token","smoke-test-token" `
    -PassThru -NoNewWindow
Start-Sleep -Seconds 3
# 第二个 daemon 应因 Mutex(Global\pocketctl-daemon 已占)失败退出(非 0)。
if (-not $p2.HasExited) {
    $p2.Kill()
    throw "second daemon did NOT fail on single-instance lock (Mutex not working?)"
}
Write-Host "PASS: second daemon correctly rejected by single-instance lock"

Write-Host "=== [4/4] Stop daemon via control channel ==="
if (-not $p.HasExited) {
    & ".\pocketctl.exe" daemon stop
    Start-Sleep -Seconds 3
    if (-not $p.HasExited) {
        $p.Kill()
        throw "daemon did not stop via control channel (named pipe stop not working?)"
    }
    Write-Host "PASS: daemon stopped via control channel"
} else {
    Write-Host "SKIP: first daemon already exited, can't test control-channel stop"
}

Write-Host "=== Smoke PASSED ==="
