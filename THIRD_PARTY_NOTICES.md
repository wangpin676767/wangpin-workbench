# 第三方元件

本專案程式碼採 MIT 授權；下列第三方元件的授權獨立有效。

- Electron：MIT。安裝目錄附 LICENSE.electron.txt（或 LICENSE）與 LICENSES.chromium.html；Chromium 另含 BSD 等多種元件授權。
- marked：MIT；DOMPurify：Apache-2.0 或 MPL-2.0；sql.js：MIT；fzstd：MIT；ws：MIT。版本由 package.json／package-lock.json 指定；完整授權隨安裝檔的 node_modules 提供，從原始碼安裝亦由 npm 取得。
- Rust 加速器依賴的完整版本／校驗碼見 native/chat-accelerator/Cargo.lock；彙整授權全文位於 src/native/THIRD_PARTY_NOTICES.txt，包含 zstd 等原生依賴。
- src/renderer/vendor 及 src/vendor 內的前端／WASM 檔案保留其原始授權標示。瀏覽器和第三方 CLI 不包含在原始碼 ZIP，需自行取得並遵守各自條款。
