# 第三方軟體聲明與授權資訊

本專案本體採用 MIT License 授權。散布與建置成果中包含或衍生自以下開放原始碼專案與元件：

## 1. 執行環境與基礎架構
- **Electron** 及 **Chromium**: 
  - 授權：MIT / BSD 授權
  - 詳細授權條款請參閱 Electron 發行目錄之 `LICENSE` 與 `LICENSES.chromium.html`。

## 2. 隨附之 npm 依賴套件（位於 resources/app/node_modules）
- **DOMPurify** (3.4.17): Apache-2.0 / MPL-2.0 授權
- **marked** (18.0.13): MIT 授權
- **sql.js** (1.14.2): MIT 授權
- **ws** (8.22.0): MIT 授權
- **fzstd** (0.1.1): MIT 授權
詳細依賴樹與雜湊見 `package-lock.json`。

## 3. 內建擴充工具鏈（src/vendor）
- **Script Doctor** (`src/vendor/scriptdoctor`):
  - 上游專案：Masngo/ScriptDoctor-AI (https://github.com/Masngo/ScriptDoctor-AI)
  - 授權：Apache License 2.0
  - 授權條款全文與修改聲明見 `src/vendor/scriptdoctor/LICENSE` 與 `src/vendor/scriptdoctor/NOTICE.md`。
- **RAGthoven** (`src/vendor/ragthoven`):
  - 上游專案：ragthoven-dev/ragthoven (https://github.com/ragthoven-dev/ragthoven)
  - 語料與幽默實驗：ragthoven-dev/semeval-2026-task-1
  - 授權：MIT License
  - 授權條款全文與修改聲明見 `src/vendor/ragthoven/LICENSE` 與 `src/vendor/ragthoven/NOTICE.md`。

## 4. 角色與情境原創聲明
- 本開源版已徹底移除所有專有 Persona Agent（包括王品 Persona、命題 Agent）與未授權之第三方角色設定。
- 內建之「長期陪伴角色（葉澄）」為原創人物設定，不含任何未授權之第三方動漫、影視或小說角色 IP。
