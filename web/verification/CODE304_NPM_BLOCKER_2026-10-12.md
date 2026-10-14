# CODE-304 — npm build verification, 12/10/2026 (Asia/Bangkok)

- Repo: `minhdienhp2013/AUTO-IN`; nhánh `ai4/dot3-web-contract-lock`; PR #15. BASE HEAD kiểm: `dbf4986da7c7786afbaf6e2a5f9871136867cbad`.
- Node `v22.16.0`; npm `10.9.2`; `registry=https://registry.npmjs.org/`; `web/package.json` giữ nguyên.
- `cd web && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=6000`: **FAIL, exit 1**, `EAI_AGAIN getaddrinfo registry.npmjs.org`, package `@types/react`.
- `cd web && npm ci`: **FAIL, exit 1**, `EUSAGE` vì chưa có `web/package-lock.json` hoặc `npm-shrinkwrap.json`.
- `cd web && npm test`: **PASS, exit 0; 48/48 unit tests**, 0 FAIL/0 SKIP. Nội dung source local được kiểm SHA blob sau khi bỏ ký tự newline bổ sung cuối file, khớp commit GitHub `dbf4986da7c7786afbaf6e2a5f9871136867cbad`.
- `cd web && npm run typecheck`: **FAIL, exit 2**, TS2688 `Cannot find type definition file for 'vite/client'` vì chưa cài dependencies.
- `cd web && npm run build`: **FAIL, exit 2**, cùng TS2688; chưa tới bước Vite bundling.
- DNS `getent ahostsv4 registry.npmjs.org` (cả `registry.npmmirror.com`, `registry.yarnpkg.com`, `github.com`) không phân giải. `curl -I https://registry.npmjs.org/react` lỗi (6), ép IP 104.16.27.34 lỗi (7). `npm cache ls` không có cache cài đặt.
- Chromium tồn tại nhưng app `web/dist/index.html` không tồn tại. **Desktop viewport 1440x900: NOT RUN; mobile viewport 390x844: NOT RUN; backend simulation E2E: NOT RUN**. Không được ghi browser/build PASS hoặc gọi là thử iPhone thật.
- **BLOCKED**: npm registry cần hoạt động để sinh lockfile bằng npm, rồi `npm ci && npm test && npm run typecheck && npm run build` và kiểm browser. Không tạo giả lockfile; không merge/deploy/in thật.

Bằng chứng lệnh/log thô bàn giao ngoài repository dưới tên `AUTO-IN-AI4-CODE304-NPM-Logs-20261012.zip` (không đưa cache/token vào Git).
