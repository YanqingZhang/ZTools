# ZTools HTTP API

ZTools 内置 HTTP 服务，允许第三方应用通过本地 HTTP 接口控制 ZTools。

## 快速开始

1. 打开 ZTools → 设置 → HTTP 服务
2. 开启「启用 HTTP 服务」
3. 复制 API 访问密钥
4. 使用任意 HTTP 客户端调用接口

## 基本信息

| 项目 | 说明 |
|------|------|
| 基础地址 | `http://127.0.0.1:36578`（端口可在设置中修改） |
| 协议 | HTTP |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |
| 认证方式 | Bearer Token |
| CORS | 已开启，允许所有来源 |

## 认证

除 `GET /` 外，所有接口均需在请求头中携带 API 密钥：

```
Authorization: Bearer <你的API密钥>
```

API 密钥可在 **设置 → HTTP 服务** 中查看和复制。

## 统一返回格式

所有接口返回 JSON，结构如下：

```json
{
  "code": 0,
  "message": "操作成功"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | `number` | 状态码，`0` 表示成功，非 `0` 表示失败 |
| `message` | `string` | 结果描述 |
| `data` | `any` | 可选，部分接口会返回额外数据 |

### 错误码

| code | HTTP 状态码 | 说明 |
|------|-------------|------|
| 0 | 200 | 操作成功 |
| 401 | 401 | API 密钥无效或未提供 |
| 404 | 200 | 未知接口路径 |
| 405 | 405 | 请求方法不允许（仅支持 GET/POST） |
| 500 | 500 | 服务器内部错误 |

---

## 接口列表

### GET / — 服务状态检测

检测 HTTP 服务是否正常运行。**无需认证**。

**请求**

```
GET /
```

**入参**

无。

**返回**

```json
{
  "code": 0,
  "message": "Hello ZTools"
}
```

**curl 示例**

```bash
curl http://127.0.0.1:36578/
```

---

### POST /api/window/show — 显示主窗口

显示 ZTools 主窗口并激活到前台。可选传入 `text` 参数，自动填充到搜索输入框。

**请求**

```
POST /api/window/show
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | `string` | 否 | 填充到搜索输入框的文本，不传则保持原有内容 |

**请求体示例**

```json
{
  "text": "搜索关键词"
}
```

请求体也可为空或空 JSON `{}`，此时仅显示窗口。

**返回**

```json
{
  "code": 0,
  "message": "操作成功"
}
```

**curl 示例**

```bash
# 仅显示窗口
curl -X POST http://127.0.0.1:36578/api/window/show \
  -H "Authorization: Bearer <API_KEY>"

# 显示窗口并填充搜索文本
curl -X POST http://127.0.0.1:36578/api/window/show \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "搜索关键词"}'
```

---

### POST /api/window/hide — 隐藏主窗口

隐藏 ZTools 主窗口。

**请求**

```
POST /api/window/hide
Authorization: Bearer <API_KEY>
```

**入参**

无。请求体可为空或空 JSON `{}`。

**返回**

```json
{
  "code": 0,
  "message": "操作成功"
}
```

**curl 示例**

```bash
curl -X POST http://127.0.0.1:36578/api/window/hide \
  -H "Authorization: Bearer <API_KEY>"
```

---

### POST /api/window/toggle — 切换主窗口显示/隐藏

如果主窗口当前可见则隐藏，不可见则显示。

**请求**

```
POST /api/window/toggle
Authorization: Bearer <API_KEY>
```

**入参**

无。请求体可为空或空 JSON `{}`。

**返回**

```json
{
  "code": 0,
  "message": "操作成功"
}
```

**curl 示例**

```bash
curl -X POST http://127.0.0.1:36578/api/window/toggle \
  -H "Authorization: Bearer <API_KEY>"
```

---

## 在各语言/工具中调用

### JavaScript / Node.js

```javascript
const response = await fetch('http://127.0.0.1:36578/api/window/show', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <API_KEY>'
  }
})
const result = await response.json()
console.log(result) // { code: 0, message: '操作成功' }
```

### Python

```python
import requests

resp = requests.post(
    'http://127.0.0.1:36578/api/window/show',
    headers={'Authorization': 'Bearer <API_KEY>'}
)
print(resp.json())  # {'code': 0, 'message': '操作成功'}
```

### AppleScript（macOS）

```applescript
do shell script "curl -s -X POST http://127.0.0.1:36578/api/window/toggle -H 'Authorization: Bearer <API_KEY>'"
```

### PowerShell（Windows）

```powershell
$headers = @{ Authorization = "Bearer <API_KEY>" }
Invoke-RestMethod -Uri "http://127.0.0.1:36578/api/window/show" -Method POST -Headers $headers
```

## 注意事项

- 服务仅监听 `127.0.0.1`，只能从本机访问，不会暴露到局域网或公网
- 默认端口 `36578`，如与其他服务冲突可在设置中修改（范围 1024~65535）
- API 密钥重新生成后，旧密钥立即失效
- 服务默认关闭，需手动在设置中开启
- 请求体大小限制为 1MB
