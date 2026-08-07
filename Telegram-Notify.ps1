# ===================================================================
# Telegram-Notify.ps1
# ===================================================================
# Envoie un message Telegram via l'API Bot officielle.
# Doc officielle : https://core.telegram.org/bots/api#sendmessage
# ===================================================================

function Send-TelegramMessage {
    param(
        [string]$BotToken,
        [string]$ChatId,
        [string]$Message
    )

    if ([string]::IsNullOrWhiteSpace($BotToken) -or [string]::IsNullOrWhiteSpace($ChatId)) {
        Write-Warning "Telegram non configure (bot_token ou chat_id manquant dans config.json) : notification ignoree."
        return $false
    }

    $url = "https://api.telegram.org/bot$BotToken/sendMessage"
    $body = @{
        chat_id                  = $ChatId
        text                     = $Message
        parse_mode               = "HTML"
        disable_web_page_preview = $true
    }

    try {
        $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -TimeoutSec 15
        if ($response.ok) {
            Write-Host "[Telegram] Notification envoyee avec succes." -ForegroundColor Green
            return $true
        } else {
            Write-Warning "[Telegram] La reponse de l'API indique un echec : $($response | ConvertTo-Json -Compress)"
            return $false
        }
    } catch {
        Write-Warning "[Telegram] Erreur lors de l'envoi de la notification : $_"
        return $false
    }
}
