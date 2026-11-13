# E2 real-voice e2e test: SAPI local TTS (zero cost, Windows built-in)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File sapi-tts.ps1 -OutFile <wav> -Text <text> [-VoiceName <voice>]
# Falls back to any installed Chinese voice; exits with error if none available.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$VoiceName = 'Microsoft Huihui Desktop'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
  if ($installed -contains $VoiceName) {
    $synth.SelectVoice($VoiceName)
  } else {
    $zh = $installed | Where-Object { $_ -match 'zh|Huihui|Yaoyao|Kangkang' } | Select-Object -First 1
    if (-not $zh) { throw "no-chinese-voice: installed=[$($installed -join ',')]" }
    $VoiceName = $zh
    $synth.SelectVoice($zh)
  }
  $synth.Rate = 0
  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($Text)
  Write-Output "OK voice=$VoiceName"
} finally {
  $synth.Dispose()
}
