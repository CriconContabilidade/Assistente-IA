# Automação de importação de baixas no Domínio

Roteiro fixo (sem IA, sem capturar tela) que leva até a tela **Resumo dos Dados** e **para ali**.
Nunca grava sozinho. Não gera custo de API: roda só no computador.

## Etapa 1 — Calibração (esta pasta)

`calibrar_dominio.ahk` só observa e anota. Não clica em nada.

1. Instale o **AutoHotkey v2** (autohotkey.com, versão 2). A opção "Portable ZIP" dispensa instalação:
   coloque o `AutoHotkey64.exe` nesta pasta e rode `AutoHotkey64.exe calibrar_dominio.ahk`.
   Com o programa instalado, basta dar dois cliques em `calibrar_dominio.ahk`.
2. Abra o Domínio normalmente (já logado).
3. Aperte **Ctrl+Alt+F9** para ligar a gravação.
4. Faça o caminho de sempre até o **Resumo dos Dados**, usando seus atalhos de teclado onde existirem
   (Utilitários > Importação > Importador > Importar, perfil, arquivo). **Não grave.**
5. Em cada tela importante (janela principal, Importador, escolha do perfil, abrir arquivo, Resumo dos Dados)
   aperte **Ctrl+Alt+F8** e dê um nome à tela (ou deixe em branco).
6. Aperte **Ctrl+Alt+F9** de novo para desligar e **Ctrl+Alt+F10** para fechar.
7. Envie o conteúdo de `calibracao_log.txt` (e diga qual caminho a pasta do Drive aparece na janela de
   abrir arquivo do Domínio, com a letra `N:`).

Privacidade: letras, números e símbolos digitados soltos **nunca** são gravados; só atalhos com
Ctrl/Alt/Win e teclas de navegação (Enter, Tab, setas, F1..F12, Esc). Os títulos das janelas podem
trazer o nome da empresa: confira o arquivo antes de enviar.

Se nenhuma tecla aparecer no registro, rode o script como administrador (o Domínio pode estar
rodando com mais privilégio).

## Etapa 2 — Roteiro de importação (depois da calibração)

Atalho único; pergunta o tipo (entradas, saídas, serviços); confere o arquivo mais recente na pasta
do Drive; mostra nome e hora e pede confirmação; percorre o caminho por atalhos de teclado conferindo
o título de cada janela; aborta com aviso se algo estiver fora do esperado; termina no Resumo dos Dados.
