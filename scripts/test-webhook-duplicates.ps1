$ErrorActionPreference = "Stop"
$baseUrl = "http://localhost:3000/api/payments/razorpay/webhook"

# Load webhook secret without printing it.
$envFile = ".env"
if (-not (Test-Path $envFile)) {
    throw ".env not found. Run script from project root."
}

$line = Get-Content $envFile |
    Where-Object { $_ -match '^\s*RAZORPAY_WEBHOOK_SECRET=' } |
    Select-Object -First 1

if (-not $line) {
    throw "RAZORPAY_WEBHOOK_SECRET not found in .env"
}

$secret = ($line -replace '^\s*RAZORPAY_WEBHOOK_SECRET=', '').Trim().Trim('"').Trim("'")

function Send-TestWebhook($eventId, $payload) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $key = [System.Text.Encoding]::UTF8.GetBytes($secret)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($key)

    try {
        $hash = $hmac.ComputeHash($bytes)
        $signature = [BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant()

        $headers = @{
            "x-razorpay-signature" = $signature
            "x-razorpay-event-id"  = $eventId
        }

        Invoke-RestMethod `
            -Uri $baseUrl `
            -Method POST `
            -Headers $headers `
            -ContentType "application/json" `
            -Body $payload
    }
    finally {
        $hmac.Dispose()
    }
}

# Existing captured payment: no new payment created.
$purchasePayload = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_TqzWqQB3y0KYPc","order_id":"order_TqzWgnLjE28Zll","amount":450000}}}}'

# Existing processed refund: no new refund created.
$refundPayload = '{"event":"refund.processed","payload":{"refund":{"entity":{"id":"rfnd_TqzdeN7MIOfMgv","payment_id":"pay_TqzWqQB3y0KYPc","amount":450000,"status":"processed"}}}}'

Write-Host "`nPurchase webhook duplicate test"
1..2 | ForEach-Object {
    Write-Host "Request $_"
    Send-TestWebhook "TqzWvVfxiaw3FU" $purchasePayload |
        ConvertTo-Json -Compress
}

Write-Host "`nRefund webhook duplicate test"
1..2 | ForEach-Object {
    Write-Host "Request $_"
    Send-TestWebhook "TqzeGc7obaMSJ3" $refundPayload |
        ConvertTo-Json -Compress
}