#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; CALIBRAÇÃO do roteiro de importação de baixas no Domínio.
;
; Este script NÃO automatiza nada e NÃO clica em nada: só observa e anota num arquivo de texto
; (calibracao_log.txt, na mesma pasta) o que é preciso pra montar o roteiro de verdade:
;   - o título, a classe e o programa de cada janela do caminho (é por eles que o roteiro vai saber
;     em que tela está e parar se algo estiver fora do esperado);
;   - as teclas de atalho que você usa (Ctrl/Alt + letra, F1..F12, Enter, Tab, setas, Esc...).
;
; PRIVACIDADE: letras, números e símbolos digitados soltos NUNCA são gravados (poderiam ser senha,
; CNPJ, valores). Só entram atalhos com Ctrl/Alt/Win e teclas de navegação. Mesmo assim, os títulos
; das janelas podem trazer o nome da empresa: dê uma olhada no arquivo antes de enviar.
;
; Teclas deste script (escolhidas pra não colidir com o Domínio):
;   Ctrl+Alt+F8  = tira uma "foto" da tela atual (janela ativa + todas as janelas abertas) e pergunta o nome da tela
;   Ctrl+Alt+F9  = liga/desliga a gravação (registra cada troca de janela e cada atalho de teclado)
;   Ctrl+Alt+F10 = fecha este script

global ARQ_LOG := A_ScriptDir "\calibracao_log.txt"
global gravando := false
global ultimaJanela := ""
global gancho := ""
global fotos := 0

^!F8::Fotografar()
^!F9::AlternarGravacao()
^!F10::ExitApp()

Registrar(texto) {
    FileAppend(FormatTime(, "HH:mm:ss") "  " texto "`n", ARQ_LOG, "UTF-8")
}

Descrever(hwnd) {
    try {
        return '"' WinGetTitle(hwnd) '"  classe=' WinGetClass(hwnd) '  programa=' WinGetProcessName(hwnd)
    } catch {
        return "(janela indisponível)"
    }
}

Fotografar() {
    global fotos
    fotos += 1
    ativa := WinExist("A")
    Registrar("===== FOTO " fotos " =====")
    Registrar("JANELA ATIVA: " Descrever(ativa))
    Registrar("TODAS AS JANELAS VISÍVEIS:")
    for hwnd in WinGetList() {
        try {
            if WinGetTitle(hwnd) = ""
                continue
            if (WinGetStyle(hwnd) & 0x10000000) = 0   ; WS_VISIBLE
                continue
        } catch {
            continue
        }
        Registrar("   " Descrever(hwnd))
    }
    ToolTip("Foto " fotos " registrada")
    SetTimer(() => ToolTip(), -1500)
    r := InputBox("Que tela é esta? (ex.: Importador, Resumo dos Dados). Pode deixar em branco.", "Calibração - foto " fotos)
    if r.Result = "OK" && r.Value != ""
        Registrar("NOME DA TELA: " r.Value)
    Registrar("")
}

AlternarGravacao() {
    global gravando, gancho, ultimaJanela
    if !gravando {
        gravando := true
        ultimaJanela := ""
        Registrar("===== GRAVAÇÃO LIGADA =====")
        gancho := InputHook("V")
        gancho.KeyOpt("{All}", "N")
        gancho.OnKeyDown := TeclaApertada
        gancho.Start()
        SetTimer(VigiarJanela, 300)
        ToolTip("Gravação LIGADA - faça o caminho normal até o Resumo dos Dados")
    } else {
        gravando := false
        SetTimer(VigiarJanela, 0)
        gancho.Stop()
        Registrar("===== GRAVAÇÃO DESLIGADA =====")
        Registrar("")
        ToolTip("Gravação desligada")
    }
    SetTimer(() => ToolTip(), -2500)
}

VigiarJanela() {
    global ultimaJanela
    hwnd := WinExist("A")
    if !hwnd
        return
    d := Descrever(hwnd)
    if d !== ultimaJanela {
        Registrar("JANELA >> " d)
        ultimaJanela := d
    }
}

TeclaApertada(ih, vk, sc) {
    nome := GetKeyName(Format("vk{:X}sc{:03X}", vk, sc))
    if RegExMatch(nome, "i)^(Control|Ctrl|Alt|Shift|LWin|RWin|LControl|RControl|LAlt|RAlt|LShift|RShift)$")
        return
    ctrl := GetKeyState("Ctrl", "P")
    alt := GetKeyState("Alt", "P")
    shift := GetKeyState("Shift", "P")
    win := GetKeyState("LWin", "P") || GetKeyState("RWin", "P")
    ; as teclas deste próprio script não entram no registro
    if ctrl && alt && RegExMatch(nome, "i)^F(8|9|10)$")
        return
    if StrLen(nome) = 1 {
        ; letra/número/símbolo: só vale como atalho com Ctrl, Alt (sem ser AltGr) ou Win
        if ctrl && alt
            return   ; AltGr (símbolos do teclado), não é atalho
        if !(ctrl || alt || win)
            return   ; digitação normal: nunca gravar
    }
    mods := (ctrl ? "Ctrl+" : "") (alt ? "Alt+" : "") (shift ? "Shift+" : "") (win ? "Win+" : "")
    Registrar("TECLA: " mods nome)
}

MsgBox("Calibração do Domínio pronta.`n`nCtrl+Alt+F8 = foto da tela atual`nCtrl+Alt+F9 = liga/desliga a gravação`nCtrl+Alt+F10 = fechar`n`nO registro vai para calibracao_log.txt, nesta pasta.", "Calibração", "T20")
