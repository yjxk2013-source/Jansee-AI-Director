# 简兮 (JANSEE) 官方前台本地开发服务器
# 严格服务 apps/web/client 目录，拒绝根目录代码污染
$port = 5173
$root = "F:\janseeV2\apps\web\client"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Output "HTTP server running at http://localhost:$port/ serving $root"

try {
    while ($listener.IsListening) {
        try {
            $context = $listener.GetContext()
            $request = $context.Request
            $response = $context.Response

            $urlPath = $request.Url.LocalPath.TrimStart('/')
            if ([string]::IsNullOrEmpty($urlPath)) {
                $urlPath = "index.html"
            }
            $urlPath = [System.Uri]::UnescapeDataString($urlPath)

            # API 请求反向代理到 3000 网关
            if ($urlPath.StartsWith("api/")) {
                try {
                    $targetUrl = "http://localhost:3000/" + $urlPath + $request.Url.Query
                    $webReq = [System.Net.HttpWebRequest]::Create($targetUrl)
                    $webReq.Method = $request.HttpMethod
                    $webReq.Timeout = 20000
                    foreach ($h in $request.Headers.AllKeys) {
                        if ($h -notin @("Host", "Connection", "Content-Length", "Accept-Encoding")) {
                            try { $webReq.Headers.Add($h, $request.Headers[$h]) } catch {}
                        }
                    }
                    if ($request.HasEntityBody) {
                        $reqStream = $webReq.GetRequestStream()
                        $request.InputStream.CopyTo($reqStream)
                        $reqStream.Close()
                    }
                    try {
                        $webResp = $webReq.GetResponse()
                    } catch [System.Net.WebException] {
                        $webResp = $_.Exception.Response
                    }
                    if ($webResp) {
                        $response.StatusCode = [int]$webResp.StatusCode
                        $response.ContentType = $webResp.ContentType
                        $respStream = $webResp.GetResponseStream()
                        $respStream.CopyTo($response.OutputStream)
                        $respStream.Close()
                        $webResp.Close()
                    } else {
                        $response.StatusCode = 502
                    }
                } catch {
                    $response.StatusCode = 500
                }
                $response.Close()
                continue
            }

            if ($urlPath.StartsWith("storage/")) {
                $filePath = Join-Path "F:\janseeV2" $urlPath
            } else {
                $filePath = Join-Path $root $urlPath
            }

            if (Test-Path $filePath -PathType Leaf) {
                $fileInfo = New-Object System.IO.FileInfo($filePath)
                $fileLength = $fileInfo.Length
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mime = "application/octet-stream"
                if ($ext -eq ".html") { $mime = "text/html; charset=utf-8" }
                elseif ($ext -eq ".css") { $mime = "text/css; charset=utf-8" }
                elseif ($ext -eq ".js") { $mime = "application/javascript; charset=utf-8" }
                elseif ($ext -eq ".mp4") { $mime = "video/mp4" }
                elseif ($ext -eq ".jpg" -or $ext -eq ".jpeg") { $mime = "image/jpeg" }
                elseif ($ext -eq ".png") { $mime = "image/png" }
                elseif ($ext -eq ".svg") { $mime = "image/svg+xml" }
                
                $response.ContentType = $mime
                $response.Headers.Add("Accept-Ranges", "bytes")
                $response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
                $response.Headers.Add("Pragma", "no-cache")
                $response.Headers.Add("Expires", "0")

                $rangeHeader = $request.Headers["Range"]
                if ($ext -eq ".mp4" -and -not [string]::IsNullOrEmpty($rangeHeader) -and $rangeHeader.StartsWith("bytes=")) {
                    $rangeStr = $rangeHeader.Substring(6).Trim()
                    $dashIdx = $rangeStr.IndexOf('-')
                    $start = 0L
                    $end = $fileLength - 1L
                    if ($dashIdx -ge 0) {
                        $startStr = $rangeStr.Substring(0, $dashIdx).Trim()
                        $endStr = $rangeStr.Substring($dashIdx + 1).Trim()
                        if (-not [string]::IsNullOrEmpty($startStr)) {
                            $start = [long]::Parse($startStr)
                        }
                        if (-not [string]::IsNullOrEmpty($endStr)) {
                            $end = [long]::Parse($endStr)
                        }
                    }
                    if ($end -ge $fileLength) { $end = $fileLength - 1L }
                    if ($start -gt $end -or $start -ge $fileLength) {
                        $response.StatusCode = 416
                        $response.Headers.Add("Content-Range", "bytes */$fileLength")
                        $response.ContentLength64 = 0
                    } else {
                        $lengthToSend = $end - $start + 1L
                        $response.StatusCode = 206
                        $response.Headers.Add("Content-Range", "bytes $start-$end/$fileLength")
                        $response.ContentLength64 = $lengthToSend
                        if ($request.HttpMethod -ne "HEAD") {
                            $fs = [System.IO.File]::OpenRead($filePath)
                            try {
                                $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
                                $buffer = New-Object byte[] 65536
                                $remaining = $lengthToSend
                                while ($remaining -gt 0) {
                                    $toRead = [Math]::Min($remaining, $buffer.Length)
                                    $read = $fs.Read($buffer, 0, $toRead)
                                    if ($read -le 0) { break }
                                    $response.OutputStream.Write($buffer, 0, $read)
                                    $remaining -= $read
                                }
                            } finally {
                                $fs.Close()
                            }
                        }
                    }
                } else {
                    $response.ContentLength64 = $fileLength
                    if ($request.HttpMethod -ne "HEAD") {
                        $fs = [System.IO.File]::OpenRead($filePath)
                        try {
                            $fs.CopyTo($response.OutputStream)
                        } finally {
                            $fs.Close()
                        }
                    }
                }
            } else {
                $response.StatusCode = 404
                $err = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                $response.ContentLength64 = $err.Length
                if ($request.HttpMethod -ne "HEAD") {
                    $response.OutputStream.Write($err, 0, $err.Length)
                }
            }
            $response.Close()
        } catch {
            $null = $_
        }
    }
} finally {
    $listener.Stop()
}
