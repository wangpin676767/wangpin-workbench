# 王品工作台 開源版本

Windows x64 多模型桌面工作台，目前版本 **1.9.137**。

[下載安裝檔、完整原始碼與 SHA256](https://github.com/wangpin676767/wangpin-workbench/releases)

支援 Codex、Claude、Antigravity、Grok Build、網頁與 API 連線，以及 wangpinplan、skill、MCP、System Prompt、影音附件分析與 Rust 加速。模型服務須自行登入並使用自己的額度。

## 安裝

下載 Release Assets 的 `wangpin-Setup-OpenSource-1.9.137.exe`，並用 `SHA256SUMS.txt` 核對。安裝位置為 `%LOCALAPPDATA%\Programs\WangpinMultiOpenSource`，資料位於 `%APPDATA%\wangpin Multi OpenSource`。

此版本不提供王品 agent 流程腳本建立、編輯或執行功能。交付不包含帳號、金鑰、對話、附件或瀏覽器使用者設定檔。

## 原始碼與建置

儲存庫提供完整應用程式來源，Release 也附完整來源 ZIP。使用 Node.js、Python 3.11+、.NET Framework C# 編譯器：執行 `npm ci`，取得 Windows x64 Electron 發行版，設定 `ELECTRON_RUNTIME_DIR` 後執行 `python build/build_offline.py`。執行 `npm test` 進行相關測試。

Rust 加速器來源位於 `native/chat-accelerator`；修改後先執行 `python build/build_native.py`（需 MSVC x64 Rust 工具鏈與 Visual Studio C++ Build Tools）。

## 驗證

68 項測試通過；來源與最終包皆通過隔離介面對話收發、保存、重開及功能移除檢查。157 個產品來源檔案與包內一致；498 個交付項目掃描未發現已知個人路徑、帳號或金鑰。未執行真實模型推論或壓力測試。

## 授權與問題回報

專案採 MIT 授權，第三方元件保留原授權，詳見 `LICENSE` 與 `THIRD_PARTY_NOTICES.md`。請透過 Issues 回報版本、Windows 版本與重現步驟，勿公開金鑰、Cookie、登入資料或私人對話。
