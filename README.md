# 王品工作台開源版

本原始碼以王品工作台 1.9.158 為基礎，提供 Windows 多模型對話、模型切換、對話管理和定時送出。 

 
## 建置與測試

需要 Windows x64、Node.js 22.12 以上、npm、Python 3 與 .NET Framework 4.x C# 編譯器。執行 `npm ci`，再執行 `npm test`。預設使用 `node_modules/electron/dist`，或透過 `ELECTRON_RUNTIME_DIR` 指向相同版本的 Electron 發行目錄；執行 `python build/build_offline.py` 產出獨立安裝包。

為避免散布非原始碼原生執行檔，此版不含可選的 Windows 原生加速模組，採用現有 JavaScript 後備路徑。定時送出需工作台保持開啟，只支援文字。

授權見 LICENSE；第三方元件及素材見 THIRD_PARTY_NOTICES.md 和各自的 LICENSE/NOTICE。涉及第三方網站、模型帳號和角色設定時，仍須遵守其各自條款。
