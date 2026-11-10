$ErrorActionPreference = 'Stop'
$projectRoot = 'C:\ecopolis-zavod'
$nodeBinary = Join-Path $env:LOCALAPPDATA 'Programs\ecopolis-node\node-v24.21.0-win-x64\node.exe'
$hostScript = Join-Path $projectRoot 'ops\intake-dispatch-host.mjs'
if (!(Test-Path -LiteralPath $nodeBinary) -or !(Test-Path -LiteralPath $hostScript)) {
    throw 'Dispatcher runtime is missing.'
}
$workerProcess = Start-Process -FilePath $nodeBinary -ArgumentList @('"' + $hostScript + '"', '--loop', '--send') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -Wait
exit $workerProcess.ExitCode
