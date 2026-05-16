# Biometric Measurement & Certification System

基於 Next.js 前端 + Go 後端 + Supabase：瀏覽器端測量、Persona 身分驗證、**後端持密鑰簽發證書**、證書驗證與「我的證書」查詢。**影像不離開裝置**，僅傳輸測量結果與驗證標識。

## 技術棧

- **Next.js 14+** (App Router)、**Supabase Auth**（登入／證書綁定）
- **Go (Gin + GORM)** 後端、**Supabase PostgreSQL**（inquiries、certificates、audit_logs）
- **TensorFlow.js**、**Persona**（Embedded Inquiry + Webhook）、**canvas-confetti**、**lucide-react**

## 環境需求

- Node.js 18+、Go 1.21+
- Supabase 專案（Auth + PostgreSQL）
- 支援 `getUserMedia` 的瀏覽器（建議 HTTPS 或 localhost）

## 快速開始

### 1. 資料庫（Supabase）

在 Supabase SQL Editor 執行 `database/migrations/001_create_inquiries_certificates_audit.sql` 內容。

### 2. 後端（Go）

```bash
cd backend
cp .env.example .env
# 編輯 .env：DATABASE_URL、CERT_HMAC_SECRET、PERSONA_WEBHOOK_SECRET、SUPABASE_JWT_SECRET
go run .
```

預設聽取 `:8080`。

### 3. 前端（Next.js）

```bash
npm install
cp .env.example .env.local
# 編輯 .env.local：NEXT_PUBLIC_API_URL、NEXT_PUBLIC_SUPABASE_*、NEXT_PUBLIC_PERSONA_*
npm run dev
```

開啟 [http://localhost:3000](http://localhost:3000)。

## 環境變數

### 前端 (.env.local)

| 變數 | 說明 |
|------|------|
| `NEXT_PUBLIC_PERSONA_TEMPLATE_ID` | Persona Inquiry Template ID |
| `NEXT_PUBLIC_PERSONA_ENV` | `sandbox` 或 `production` |
| `NEXT_PUBLIC_API_URL` | 後端 API 網址（例 `http://localhost:8080`） |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_MEASUREMENT_RECOGNITION_MODEL_URL` | 測量區 ML 辨識模型 URL（TF.js GraphModel），不設定則使用啟發式 fallback |

### 後端 (backend/.env)

| 變數 | 說明 |
|------|------|
| `DATABASE_URL` | Supabase PostgreSQL 連線字串 |
| `CERT_HMAC_SECRET` | 證書 HMAC 密鑰（僅後端，前端無此密鑰） |
| `PERSONA_WEBHOOK_SECRET` | Persona Webhook 簽名驗證 |
| `SUPABASE_JWT_SECRET` | 驗證前端 JWT（Supabase Dashboard → API → JWT Secret） |
| `CORS_ORIGIN` | 允許的 frontend origin（多個以逗號分隔） |

## 流程概覽

1. **年齡驗證**（新）：首次使用須確認年滿 18 歲並同意敏感內容。
2. **登入**：Supabase Auth（/login：密碼或魔法連結）。
3. **相機擷取 — 護照校準**：系統自動偵測綠框內的護照邊緣（CV 角點偵測），驗證長寬比後計算 PPM。
4. **旋轉活體檢測**（新）：系統隨機要求順時針或逆時針旋轉約 30°，追蹤 ROI 內特徵點確認同一物體的真實 3D 旋轉。
5. **多幀測量**（新）：通過旋轉驗證後連續 capture 5 幀，去極值取平均，標準差 > 0.5cm 要求重測。
6. **身分驗證**：Persona Embedded Inquiry → Persona Webhook 通知後端 `inquiry.completed`。
7. **數位證書**（修正）：僅在 Step 4（身分驗證後）可下載 PNG/PDF/JSON 證書，Step 2 不再顯示下載按鈕。
8. **我的證書**：/certificates 多裝置同步。
9. **驗證證書**：/verify 貼上證書 JSON 驗證 HMAC 簽名。

## 專案結構

```
app/
  page.tsx           # 首頁流程（含年齡驗證閘門）
  login/page.tsx     # 登入
  certificates/page.tsx  # 我的證書
  verify/page.tsx    # 驗證證書
components/
  CameraCapture.tsx  # 相機 + 旋轉活體檢測 + overlay 指引
  PersonaInquiry.tsx # Persona SDK（含 SRI 支援）
  RotationGuide.tsx  # 旋轉動態測驗之向量圖形指引（新）
lib/
  measurementEngine.ts   # PPM、透視校正 warp、多幀平均（修正）
  measurementVerification.ts  # ML 辨識 + Web Worker 推論（新增）
  passportDetector.ts    # 護照邊緣偵測與角點定位（新）
  segmentationModel.ts   # TF.js UNet / 啟發式分割（新）
  rotationTracker.ts     # 特徵點追蹤與旋轉角度估算（新）
  distortionCorrection.ts # 鏡頭畸變校正（新）
  certificationProvider.ts # 僅開發用（前端無密鑰）
  certificateImage.ts    # 多語言證書 PNG 生成
  workers/
    inference.worker.ts  # ML 推論 Web Worker（新）
backend/
  main.go                # + rate limiter, + DELETE 端點
  internal/
    middleware/
      auth.go            # 嚴格 CORS origin 驗證
      ratelimit.go       # Token bucket rate limiter（新）
    handler/
      certificates.go    # + DELETE, + input validation
      collection.go      # 檔案大小/格式驗證
database/migrations/
  001_create_inquiries_certificates_audit.sql
```

## 核心改進說明

### Phase 1 — 測量管線重構

| 改進 | 檔案 | 說明 |
|------|------|------|
| 護照邊緣偵測 | `lib/passportDetector.ts` | 以 Sobel gradient + connected component 取代固定 overlay 座標，驗證 aspect ratio (125/88) |
| 透視校正 | `lib/measurementEngine.ts` | 啟用 `buildPerspectiveMatrix` + bilinear interpolation warp，校正 foreshortening |
| 物件分割 | `lib/segmentationModel.ts` | TF.js UNet 或自適應閾值 fallback，取代固定 `height*0.35` |
| 旋轉活體檢測 | `lib/rotationTracker.ts` | FAST corner + block matching optical flow，要求順時針/逆時針旋轉 30° |
| 多幀平均 | `measure/page.tsx` | 5 幀 capture，去極值平均 3 幀，std > 0.5cm 要求重測 |
| Web Worker 推論 | `lib/workers/inference.worker.ts` | TF.js 推論在 Worker 執行，不阻塞主執行緒 |

### Phase 2 — UI/UX 改善

| 改進 | 檔案 | 說明 |
|------|------|------|
| 旋轉向量指引 | `components/RotationGuide.tsx` | 動畫箭頭、進度圓環、即時角度顯示 |
| 取消旋轉挑戰 | `CameraCapture.tsx` | 活體檢測期間可取消返回 idle |
| 下載按鈕可重複 | `measure/page.tsx` | 移除 single-download disabled flag |
| 環境指示燈整合 | `CameraCapture.tsx` | 燈號移至 camera overlay 左上角 |
| 證書僅 Step 4 | `measure/page.tsx` | Step 2 移除下載按鈕與 holder name |
| 手機 Nav bar | `measure/page.tsx` | <768px 使用 hamburger menu |
| 敏感模糊降級 | `globals.css` | blur(12px) → blur(6px)，新增局部模糊 class |
| 多語言浮水印 | `certificateImage.ts` | "Dick Size Verified" 依 locale 翻譯（4 語系） |

### Phase 3 — 安全性強化

| 改進 | 說明 |
|------|------|
| 移除前端 HMAC secret | 前端不再持有 `NEXT_PUBLIC_CERT_SECRET_KEY`；簽名僅後端執行 |
| API rate limiting | Token bucket per IP：POST 證書 10/min、collection 30/min、GET 60/min |
| 輸入驗證 | lengthCm 0-50cm、ppm 50-500、timestamp 不可在未來 |
| 嚴格 CORS | 僅允許 config 中明列的 origin，不支援 wildcard |
| SRI 準備 | Persona SDK script 加入 `crossOrigin="anonymous"` 與 integrity placeholder |
| Session timeout | 30 分鐘無活動自動登出（useAuth） |
| 上傳限制 | collection endpoint 限制檔案大小 2MB + 格式檢查（PNG/JPEG magic bytes） |

### Phase 4 — 效能與合規

| 改進 | 說明 |
|------|------|
| Web Worker | TF.js 推論在獨立 Worker 執行，主執行緒不阻塞 |
| 鏡頭畸變校正 | `lib/distortionCorrection.ts` 使用 Brown-Conrady 模型 + bilinear interpolation |
| DELETE API | `DELETE /api/certificates/:id`（僅擁有者可刪除） |
| 年齡驗證閘門 | 首次使用 double checkbox 確認 18+ 與敏感內容同意（存 sessionStorage） |

## Persona Webhook

在 Persona Dashboard 設定 Webhook URL：`https://<你的後端>/webhooks/persona`，訂閱 `inquiry.completed`，並將 Webhook secret 設為後端 `PERSONA_WEBHOOK_SECRET`。

## 測量區 ML 辨識模型

### 分割模型（新，選擇性）

設定 `NEXT_PUBLIC_MEASUREMENT_RECOGNITION_MODEL_URL` 後，`lib/segmentationModel.ts` 會載入 TF.js GraphModel 對 ROI 做像素級分割：

- **格式**：TF.js GraphModel（可由 Keras UNet / MobileNetV2+UNet 轉換）
- **輸入**：224×224 RGB，數值正規化至 [0, 1]
- **輸出**：224×224 單通道 binary mask（sigmoid）
- **門檻**：0.5 二值化後取最大連通區域之垂直邊界

未設定時使用自適應閾值 + connected component 作為啟發式 fallback。

### 訓練管線

`ML_Training_Instance/` 目錄提供 MobileNetV2 transfer learning 二元分類器訓練 + TF.js 匯出。新增 segmentation 訓練腳本規劃中。

## 隱私與合規

- **年齡驗證閘門**（新）：須確認 18+ 方可使用服務
- **端點脫敏**：CSS blur（6px），新增局部模糊（僅模糊測量區）
- **零存儲**：影像不寫入 localStorage/IndexedDB
- **證書刪除**：`DELETE /api/certificates/:id` 支援使用者刪除
- **稽核日誌**：所有 certificate 操作皆有 audit log
- **Session 逾時**：30 分鐘無活動自動登出

## 建置與部署

```bash
# 前端
npm run build && npm start

# 後端
cd backend && go build -o cert-backend . && ./cert-backend
```
