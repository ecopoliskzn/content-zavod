param([string]$OutputFile = 'C:\ecopolis-zavod\.local-secrets\handoff\ecopolis-backup-password.json')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$taskNode = Join-Path $env:LOCALAPPDATA 'Programs\ecopolis-node\node-v24.21.0-win-x64\node.exe'
if (!(Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
if (Test-Path -LiteralPath $OutputFile) { throw 'Output already exists. Preserve it and choose another filename.' }
function Read-TaskSecret([string]$Prompt) {
    $taskSecure = Read-Host $Prompt -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer); $taskSecure.Dispose() }
}
$taskTemporary = Join-Path $taskRoot ('.local-secrets\handoff-temp-' + [guid]::NewGuid().ToString('N'))
try {
    $taskPassword = Read-TaskSecret 'Choose a NEW transfer password (at least 16 characters)'
    $taskConfirm = Read-TaskSecret 'Repeat transfer password'
    if ($taskPassword.Length -lt 16 -or $taskPassword -cne $taskConfirm) { throw 'Passwords differ or are too short.' }
    New-Item -ItemType Directory -Path $taskTemporary -Force | Out-Null
    $taskAcl = New-Object Security.AccessControl.DirectorySecurity
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskIdentity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $taskAcl.AddAccessRule($taskRule)
    Set-Acl -LiteralPath $taskTemporary -AclObject $taskAcl
    $taskPlain = Join-Path $taskTemporary 'source.tmp'
    & scp -o StrictHostKeyChecking=yes 'zavod@104.171.136.64:/opt/ecopolis-data/.backup-pass' $taskPlain
    if ($LASTEXITCODE -ne 0) { throw 'Transfer failed.' }
    New-Item -ItemType Directory -Path (Split-Path $OutputFile -Parent) -Force | Out-Null
    $taskStart = New-Object Diagnostics.ProcessStartInfo
    $taskStart.FileName = $taskNode
    $taskStart.Arguments = '"' + (Join-Path $taskRoot 'ops\backup-envelope.mjs') + '"'
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardInput = $true
    $taskStart.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $taskProcess = [Diagnostics.Process]::Start($taskStart)
    $taskPayload = @{source=$taskPlain;output=$OutputFile;password=$taskPassword} | ConvertTo-Json -Compress
    $taskProcess.StandardInput.Write($taskPayload)
    $taskProcess.StandardInput.Close()
    $taskProcess.WaitForExit()
    if ($taskProcess.ExitCode -ne 0) { throw 'Encryption failed.' }
    Write-Output ('Encrypted handoff file: ' + $OutputFile)
    Write-Output 'Send the encrypted JSON and backup-password-open.html to the client. Send the transfer password separately.'
} finally {
    $taskPayload=$null; $taskPassword=$null; $taskConfirm=$null
    if (Test-Path -LiteralPath $taskTemporary) {
        $taskResolved = [IO.Path]::GetFullPath($taskTemporary)
        $taskAllowed = [IO.Path]::GetFullPath((Join-Path $taskRoot '.local-secrets')) + [IO.Path]::DirectorySeparatorChar
        if (!$taskResolved.StartsWith($taskAllowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup path.' }
        Remove-Item -LiteralPath $taskResolved -Recurse -Force
    }
}
