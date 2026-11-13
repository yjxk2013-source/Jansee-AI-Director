' speak.vbs - SAPI TTS to WAV (zero dependency, offline)
' Usage: cscript //nologo speak.vbs <text_utf8.txt> <out.wav> [rate:-2..2]
Function ReadUtf8(p)
  Dim st : Set st = CreateObject("ADODB.Stream")
  st.Type = 2
  st.CharSet = "utf-8"
  st.Open
  st.LoadFromFile p
  ReadUtf8 = st.ReadText
  st.Close
End Function

Dim args : Set args = WScript.Arguments
If args.Count < 2 Then
  WScript.Echo "usage: cscript //nologo speak.vbs text.txt out.wav [rate]"
  WScript.Quit 1
End If

Dim txt : txt = ReadUtf8(args(0))
Dim out : out = args(1)
Dim rate : rate = 0
If args.Count >= 3 Then rate = CInt(args(2))

Dim fs : Set fs = CreateObject("SAPI.SpFileStream")
fs.Format.Type = 34 ' SAFT44kHz16BitStereo
fs.Open out, 3 ' SSFMCreateForWrite

Dim v : Set v = CreateObject("SAPI.SpVoice")
' pick a Chinese voice if available (prefer Huihui / Yaoyao / Kangkang)
Dim picked : picked = False
Dim vs : Set vs = v.GetVoices
Dim i
For i = 0 To vs.Count - 1
  Dim nm : nm = LCase(vs(i).GetDescription)
  If InStr(nm, "huihui") > 0 Or InStr(nm, "yaoyao") > 0 Or InStr(nm, "kangkang") > 0 Then
    Set v.Voice = vs(i)
    picked = True
    Exit For
  End If
Next
If Not picked Then WScript.Echo "WARN: no Chinese voice found, using default"

v.Rate = rate
v.Volume = 100
Set v.AudioOutputStream = fs
v.Speak txt
fs.Close
WScript.Echo "OK " & out & " voice=" & picked
