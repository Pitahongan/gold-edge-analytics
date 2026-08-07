# ===================================================================
# Test-Telegram.ps1
# ===================================================================
# Envoie un message de test pour verifier que la configuration Telegram
# (bot_token + chat_id dans config.json) fonctionne, AVANT de compter
# dessus pour les vraies alertes d'edge.
# ===================================================================

$scriptDir = $PSScriptRoot
. (Join-Path $scriptDir "Telegram-Notify.ps1")

$configPath = Join-Path $scriptDir "config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[ERREUR] config.json introuvable." -ForegroundColor Red
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

$config = Get-Content -Raw $configPath | ConvertFrom-Json
$botToken = $config.telegram_bot_token
$chatId = $config.telegram_chat_id

Write-Host "==================================================="
Write-Host "   TEST DE LA NOTIFICATION TELEGRAM"
Write-Host "==================================================="
Write-Host ""

if ([string]::IsNullOrWhiteSpace($botToken) -or [string]::IsNullOrWhiteSpace($chatId)) {
    Write-Host "[ERREUR] telegram_bot_token ou telegram_chat_id manquant dans config.json." -ForegroundColor Red
    Write-Host "Suivez le guide fourni pour créer votre bot et récupérer votre chat_id." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

Write-Host "Envoi d'un message de test a votre bot Telegram..." -ForegroundColor Cyan
$testMessage = "<b>Gold Edge Analytics</b>`nCeci est un message de test. Si vous voyez ceci, la configuration Telegram fonctionne parfaitement !"

$success = Send-TelegramMessage -BotToken $botToken -ChatId $chatId -Message $testMessage

Write-Host ""
if ($success) {
    Write-Host "SUCCES : vérifiez votre téléphone, le message devrait être arrivé." -ForegroundColor Green
} else {
    Write-Host "ECHEC : vérifiez votre bot_token et chat_id dans config.json (voir le guide)." -ForegroundColor Red
}
Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"
