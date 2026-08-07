# ===================================================================
# Windows-Notify.ps1
# ===================================================================
# Notification native Windows (Centre de notifications / toast), pour
# recevoir les alertes Gold Edge sur le PC quand le telephone n'est pas
# a portee. Complementaire a Telegram-Notify.ps1, pas un remplacement.
#
# Pas de module externe (pas de BurntToast) : utilise directement les API
# WinRT via Windows PowerShell 5.1. Astuce necessaire : Windows exige un
# AppId enregistre pour afficher un toast -> on reutilise l'AppId DEJA
# enregistre de powershell.exe (astuce standard, evite d'avoir a creer un
# raccourci Menu Demarrer avec un AppUserModelID dedie).
# ===================================================================

function Send-WindowsToast {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Message
    )
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

        # Echappement XML minimal (titre/message viennent de nos propres
        # donnees de marche, mais on reste prudent si un chiffre/texte
        # contient un caractere special comme & ou <).
        $escape = { param($s) [System.Security.SecurityElement]::Escape($s) }
        $safeTitle = & $escape $Title
        $safeMessage = & $escape $Message

        [xml]$template = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>$safeTitle</text>
            <text>$safeMessage</text>
        </binding>
    </visual>
    <audio src="ms-winsoundevent:Notification.Default" />
</toast>
"@
        $xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xmlDoc.LoadXml($template.OuterXml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xmlDoc

        # AppId de powershell.exe (deja enregistre aupres de Windows) :
        # evite l'erreur "l'element est introuvable" qui survient avec un
        # AppId arbitraire non enregistre dans le menu Demarrer.
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
        return $true
    } catch {
        Write-Warning "Notification Windows echouee (Telegram reste envoye normalement) : $_"
        return $false
    }
}
