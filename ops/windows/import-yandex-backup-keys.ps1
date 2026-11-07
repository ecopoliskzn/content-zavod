param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('(?-i:^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$)')]
    [string]$Bucket
)
# Stage a candidate only. Production settings are never switched by this script.
$ErrorActionPreference = 'Stop'
$taskServer = 'zavod@104.171.136.64'
$taskIdentityFile = Join-Path $env:USERPROFILE '.ssh\ecopolis_operator_ed25519'
$taskKnownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'
$taskSshArgs = @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile=' + $taskKnownHosts),'-i',$taskIdentityFile)
$taskLocalFile = Join-Path $env:TEMP ('ecopolis-yandex-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
$taskRemoteDir = $null
function Read-TaskSecret([string]$Prompt) {
    $taskSecure = Read-Host $Prompt -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer); $taskSecure.Dispose() }
}
try {
    $taskAccess = Read-TaskSecret 'Paste Yandex S3 Access Key'
    $taskSecret = Read-TaskSecret 'Paste Yandex S3 Secret Key'
    if ($taskAccess.Length -lt 8 -or $taskSecret.Length -lt 8 -or $taskAccess -notmatch '^[\x21-\x7e]+$' -or $taskSecret -notmatch '^[\x21-\x7e]+$' -or $taskAccess -match '^[*.]+$' -or $taskSecret -match '^[*.]+$') {
        throw 'Paste full unmasked ASCII values, not masked dots or labels.'
    }
    New-Item -ItemType File -Path $taskLocalFile | Out-Null
    $taskAcl = New-Object Security.AccessControl.FileSecurity
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow'))
    Set-Acl -LiteralPath $taskLocalFile -AclObject $taskAcl
    $taskContent = "BACKUP_S3_ENDPOINT=https://storage.yandexcloud.net`nBACKUP_S3_BUCKET=$Bucket`nBACKUP_S3_REGION=ru-central1`nBACKUP_S3_ACCESS_KEY=$taskAccess`nBACKUP_S3_SECRET_KEY=$taskSecret`n"
    [IO.File]::WriteAllText($taskLocalFile,$taskContent,[Text.UTF8Encoding]::new($false))
    $taskContent=$null; $taskAccess=$null; $taskSecret=$null
    $taskRemoteOutput = & ssh @taskSshArgs $taskServer 'mktemp -d /tmp/ecopolis-yandex-backup.XXXXXXXX'
    if ($LASTEXITCODE -ne 0) { throw 'SSH failed before transfer.' }
    $taskRemoteDir = ([string]$taskRemoteOutput).Trim()
    if ($taskRemoteDir -notmatch '^/tmp/ecopolis-yandex-backup\.[A-Za-z0-9]{8}$') { $taskRemoteDir=$null; throw 'Unexpected temporary directory.' }
    & scp @taskSshArgs $taskLocalFile "${taskServer}:${taskRemoteDir}/keys.tmp"
    if ($LASTEXITCODE -ne 0) { throw 'Transfer failed.' }
    & ssh @taskSshArgs $taskServer "chmod 600 $taskRemoteDir/keys.tmp && cd /opt/ecopolis-zavod/current && ZAVOD_ENV_FILE=/opt/ecopolis-data/.backup-yandex-candidate.env npm run tokens -- --import=$taskRemoteDir/keys.tmp"
    if ($LASTEXITCODE -ne 0) { throw 'Candidate import failed.' }
    Write-Output 'Yandex backup candidate imported. Production settings were not changed.'
} finally {
    $taskContent=$null; $taskAccess=$null; $taskSecret=$null
    if (Test-Path -LiteralPath $taskLocalFile) { Remove-Item -LiteralPath $taskLocalFile -Force }
    if ($taskRemoteDir) { & ssh @taskSshArgs $taskServer "rm -f $taskRemoteDir/keys.tmp; rmdir $taskRemoteDir" }
}
