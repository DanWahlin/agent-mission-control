# Signs the Windows app with Azure Artifact Signing, so Smart App Control and SmartScreen trust it.
# Release builds use it (.github/workflows/build.yml); a local build is not signed.
#
#   windows-signing.ps1 -Setup             Downloads signtool and the signing library, and saves
#                                          their paths for the next steps (GITHUB_ENV).
#   windows-signing.ps1 -Sign <file>...    Signs files. Tauri runs this for the app, the NSIS
#                                          plugins, uninstaller and installer, and the MSI
#                                          (bundle.windows.signCommand).
#   windows-signing.ps1 -Verify <file>...  Fails unless each file has our valid signature.
#
# Signing needs `azure/login` first and these variables (the `release` environment sets them):
# ARTIFACT_SIGNING_ENDPOINT, ARTIFACT_SIGNING_ACCOUNT, ARTIFACT_SIGNING_PROFILE.
[CmdletBinding(DefaultParameterSetName = 'Sign')]
param(
  [Parameter(ParameterSetName = 'Setup', Mandatory)] [switch] $Setup,
  [Parameter(ParameterSetName = 'Sign', Mandatory, Position = 0, ValueFromRemainingArguments)] [string[]] $Sign,
  [Parameter(ParameterSetName = 'Verify', Mandatory)] [string[]] $Verify
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pinned, and checked against these SHA-256s. The signing library is x64 only; on Windows on Arm the
# x64 signtool loads it under emulation, with an x64 .NET 8.
$packages = @(
  @{Name = 'microsoft.artifactsigning.client'; Version = '1.0.146'
    Sha256 = '7761e5d8f31e54b764da21d33cd8b0a2940e1b05526c7dfcb5e94b0431426f70'},
  @{Name = 'microsoft.windows.sdk.buildtools'; Version = '10.0.28000.2705'
    Sha256 = '8bfdfb6ca2633f531cf80b5fa22512ba61a394d7988f0970db83baadc67929ed'}
)
$timestamp = 'http://timestamp.acs.microsoft.com'
# The publisher on our certificate (the identity that Artifact Signing validated).
$publisher = 'CN=Dan Wahlin'

function Save-Env([string] $name, [string] $value) {
  Set-Item "env:$name" $value
  if ($env:GITHUB_ENV) { Add-Content -LiteralPath $env:GITHUB_ENV -Value "$name=$value" -Encoding utf8 }
}

function Invoke-Setup {
  foreach ($name in 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE') {
    if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue).Value) {
      throw "$name is not set. Release builds sign in the 'release' environment, which sets it."
    }
  }
  $tools = Join-Path ($env:RUNNER_TEMP ?? [IO.Path]::GetTempPath()) 'artifact-signing'
  New-Item -ItemType Directory -Force $tools | Out-Null
  foreach ($package in $packages) {
    $file = Join-Path $tools "$($package.Name).nupkg"
    $url = "https://api.nuget.org/v3-flatcontainer/$($package.Name)/$($package.Version)/$($package.Name).$($package.Version).nupkg"
    for ($attempt = 1; ; $attempt++) {
      try { Invoke-WebRequest $url -OutFile $file; break }
      catch { if ($attempt -ge 3) { throw }; Start-Sleep -Seconds (5 * $attempt) }
    }
    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $package.Sha256) { throw "SHA-256 mismatch for $($package.Name) $($package.Version): $hash" }
    Expand-Archive $file (Join-Path $tools $package.Name) -Force
  }
  $signtool = Get-ChildItem (Join-Path $tools 'microsoft.windows.sdk.buildtools') -Recurse -Filter signtool.exe |
    Where-Object { $_.Directory.Name -eq 'x64' } | Select-Object -First 1
  $dlib = Get-ChildItem (Join-Path $tools 'microsoft.artifactsigning.client') -Recurse -Filter Azure.CodeSigning.Dlib.dll |
    Where-Object { $_.Directory.Name -eq 'x64' } | Select-Object -First 1
  if (-not $signtool -or -not $dlib) { throw 'The signing packages do not have the x64 signtool and signing library.' }

  # The runner's own .NET can be Arm64 only; the x64 library needs an x64 runtime.
  $dotnet = Join-Path $tools 'dotnet-x64'
  $installer = Join-Path $tools 'dotnet-install.ps1'
  Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile $installer
  & $installer -Runtime dotnet -Channel 8.0 -Architecture x64 -InstallDir $dotnet -NoPath | Out-Null
  Save-Env DOTNET_ROOT_X64 $dotnet

  # Only the Azure CLI login (from azure/login) is used, so a stray credential can't sign.
  $metadata = Join-Path $tools 'metadata.json'
  @{
    Endpoint = $env:ARTIFACT_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:ARTIFACT_SIGNING_ACCOUNT
    CertificateProfileName = $env:ARTIFACT_SIGNING_PROFILE
    ExcludeCredentials = @('ManagedIdentityCredential', 'EnvironmentCredential', 'WorkloadIdentityCredential',
      'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
      'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
  } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
  Save-Env MISSION_CONTROL_SIGNTOOL $signtool.FullName
  Save-Env MISSION_CONTROL_SIGNING_DLIB $dlib.FullName
  Save-Env MISSION_CONTROL_SIGNING_METADATA $metadata
  Write-Host "Signing is set up with $($signtool.FullName)"
}

function Invoke-Sign([string[]] $files) {
  foreach ($name in 'MISSION_CONTROL_SIGNTOOL', 'MISSION_CONTROL_SIGNING_DLIB', 'MISSION_CONTROL_SIGNING_METADATA') {
    if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue).Value) { throw "$name is not set; run -Setup first." }
  }
  foreach ($file in $files) {
    $path = (Resolve-Path -LiteralPath $file).Path
    # The signing service and the timestamp server can fail for a moment; a signature is all or nothing.
    for ($attempt = 1; ; $attempt++) {
      & $env:MISSION_CONTROL_SIGNTOOL sign /fd SHA256 /tr $timestamp /td SHA256 `
        /dlib $env:MISSION_CONTROL_SIGNING_DLIB /dmdf $env:MISSION_CONTROL_SIGNING_METADATA $path
      if ($LASTEXITCODE -eq 0) { break }
      if ($attempt -ge 3) { throw "Couldn't sign $path (signtool exit code $LASTEXITCODE)." }
      Start-Sleep -Seconds (10 * $attempt)
    }
    Invoke-Verify @($path)
  }
}

function Invoke-Verify([string[]] $files) {
  foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    $subject = $signature.SignerCertificate.Subject
    if ($signature.Status -ne 'Valid' -or -not $subject.StartsWith($publisher) -or -not $signature.TimeStamperCertificate) {
      throw "$file is not signed by $publisher with a timestamp ($($signature.Status): $subject)."
    }
    Write-Host "Signed: $file"
  }
}

switch ($PSCmdlet.ParameterSetName) {
  'Setup' { Invoke-Setup }
  'Sign' { Invoke-Sign $Sign }
  'Verify' { Invoke-Verify $Verify }
}
