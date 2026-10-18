# Vendored libraries

Kept in the repo so the app doesn't depend on someone else's CDN.

| File | Library | Version | License |
|---|---|---|---|
| `zxing.min.js` | [@zxing/library](https://github.com/zxing-js/library) (UMD build) | 0.21.3 | Apache-2.0 (`LICENSE-zxing.txt`) |
| `jsbarcode.min.js` | [JsBarcode](https://github.com/lindell/JsBarcode) (`JsBarcode.all.min.js`) | 3.11.6 | MIT (`LICENSE-jsbarcode.txt`) |
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT (in file header) |

To update one, download the new version from npm (`npm pack <name>@<version>`), copy the same file in, and update this table.
