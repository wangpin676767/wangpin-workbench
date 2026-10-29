# 王品工作台開源版

本原始碼以王品工作台 1.9.158 為基礎，提供 Windows 多模型對話、模型切換、對話管理和定時送出。此版移除 Persona Agent 與王品 Agent 腳本功能及其後端、畫面和 IPC；一般子 Agent 及 wangpinplan 為其他功能。

## 隱私與登入

原始碼及安裝包不附作者的使用者資料、對話、附件、設定、登入憑證或瀏覽器設定檔。開源版預設使用 `%APPDATA%\Wangpin Workbench Open Source`，Codex 預設使用該目錄內獨立的 `codex-home`；預設不自動複製 Brave 登入或 Claude Desktop 憑證。使用者可自行登入或選擇其他資料夾；手動匯入資料後，該電腦上的資料由使用者管理。選用的模型供應商、工具或網站會接收執行所需資料，使用前請檢查其政策。

開源版沒有發佈使用者的聊天或自動上傳個人資料；請勿把自己的設定、對話、附件、帳號檔、`.env`、瀏覽器資料或 token 加進儲存庫。這份檢查不能保證所有第三方套件或後續改動均無問題。

## 建置與測試

需要 Windows x64、Node.js 22.12 以上、npm、Python 3 與 .NET Framework 4.x C# 編譯器。執行 `npm ci`，再執行 `npm test`。預設使用 `node_modules/electron/dist`，或透過 `ELECTRON_RUNTIME_DIR` 指向相同版本的 Electron 發行目錄；執行 `python build/build_offline.py` 產出獨立安裝包。

為避免散布非原始碼原生執行檔，此版不含可選的 Windows 原生加速模組，採用現有 JavaScript 後備路徑。定時送出需工作台保持開啟，只支援文字。

授權見 LICENSE；第三方元件及素材見 THIRD_PARTY_NOTICES.md 和各自的 LICENSE/NOTICE。涉及第三方網站、模型帳號和角色設定時，仍須遵守其各自條款。
