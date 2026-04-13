---
name: feishu-sheets
description: |
  飞书电子表格（Sheets）的读取、写入、追加、查找和导出工具。

  **当以下情况时使用此 Skill**：
  (1) 用户需要读取或写入飞书电子表格数据
  (2) 用户提到"电子表格"、"表格"、"sheet"、"sheets"、"Excel"、"表单"
  (3) 需要创建新的电子表格（含初始数据/表头）
  (4) 需要在现有表格末尾追加数据
  (5) 需要在表格中查找特定内容
  (6) 需要将表格导出为 xlsx 或 csv 文件

  **不要使用**：多维表格/Bitable 请用 feishu-bitable skill。电子表格与多维表格是完全不同的产品。
---

# Feishu Sheets（电子表格）Skill

## 🚨 执行前必读

- ✅ **工具名称**：`feishu_sheet`（单数），不是 `feishu_sheets`
- ✅ **token 获取**：优先使用 URL（自动解析），也支持直接传 `spreadsheet_token`。知识库 wiki URL 也支持，工具自动解析为电子表格 token
- ✅ **range 格式**：`<sheetId>!A1:D10`。不填 range 则自动使用第一个工作表
- ✅ **sheet_id 获取**：先调用 `info` action 获取所有工作表列表及其 `sheet_id`
- ⚠️ **write 是覆盖写入（高危）**：从指定位置开始覆盖，会清除原有数据。追加数据请用 `append`
- ✅ **read 上限**：单次最多返回 200 行。超出时响应中包含 `truncated: true`，需缩小 range 分批读取
- ✅ **write/append 上限**：单次最多 5000 行 × 100 列
- ✅ **CSV 导出必须指定 sheet_id**：CSV 一次只能导出单个工作表
- ✅ **find 的 sheet_id 必填**：find action 中 `sheet_id` 为必填参数

---

## 📋 快速索引：意图 → 工具 → 必填参数

| 用户意图 | action | 必填参数 | 常用可选 |
|---------|--------|---------|---------|
| 查看表格信息/工作表列表 | `info` | `url` 或 `spreadsheet_token` | — |
| 读取数据 | `read` | `url` 或 `spreadsheet_token` | `range`, `sheet_id`, `value_render_option` |
| 覆盖写入（高危） | `write` | `url`/`spreadsheet_token`, `values` | `range`, `sheet_id` |
| 追加行到末尾 | `append` | `url`/`spreadsheet_token`, `values` | `range`, `sheet_id` |
| 查找单元格 | `find` | `url`/`spreadsheet_token`, `sheet_id`, `find` | `range`, `match_case`, `search_by_regex` |
| 创建新表格 | `create` | `title` | `folder_token`, `headers`, `data` |
| 导出 xlsx | `export` | `url`/`spreadsheet_token`, `file_extension: "xlsx"` | `output_path`, `sheet_id` |
| 导出 CSV | `export` | `url`/`spreadsheet_token`, `file_extension: "csv"`, `sheet_id` | `output_path` |

---

## 🎯 核心约束（Schema 未透露的知识）

### 1. spreadsheet_token 获取方式

**优先使用 URL 参数**（最简单，工具自动解析）：

```json
{
  "action": "read",
  "url": "https://xxx.feishu.cn/sheets/TOKEN"
}
```

也支持知识库链接：`https://xxx.feishu.cn/wiki/TOKEN`（自动解析为电子表格 token）

URL 中的 `?sheet=SHEET_ID` 也会被自动解析并用作默认工作表。

**直接使用 token**：

```json
{
  "action": "read",
  "spreadsheet_token": "sht_xxxxxx"
}
```

### 2. range 格式规范

| 场景 | 格式示例 | 说明 |
|------|---------|------|
| 全工作表 | 不填（或填 `sheet_id`） | 自动读取第一个工作表全部数据 |
| 指定工作表 | `sheetId`（sheet_id 参数） | 读取该工作表全部数据 |
| 指定区域 | `sheetId!A1:D10` | 读取 A1 到 D10 的矩形区域 |
| find 的 range | `A1:D10`（不含 sheetId 前缀） | find action 中 range 不加 sheetId 前缀 |

**sheetId 通过 `info` action 获取**，格式类似 `0HkSJa`（6 位字母数字串，不是工作表名称）。

### 3. values 格式（二维数组）

`values` 是行优先的二维数组，每个内层数组是一行：

```json
[
  ["姓名", "部门", "入职日期"],
  ["张三", "工程", "2026-01-01"],
  ["李四", "产品", "2026-02-15"]
]
```

- 空单元格传空字符串 `""` 或 `null`
- 数字、字符串、布尔值均可直接传入
- 不支持公式写入（write/append 不接受以 `=` 开头的公式字符串用于计算）

### 4. value_render_option（读取渲染方式）

| 选项 | 说明 | 使用场景 |
|------|------|---------|
| `ToString`（默认） | 将值转为字符串，日期转为可读文本 | 通常使用此选项 |
| `FormattedValue` | 按单元格格式显示 | 需要看到格式化后的数值（如货币、百分比） |
| `Formula` | 返回公式原文 | 需要分析公式 |
| `UnformattedValue` | 原始数值，日期为序列号 | 需要精确数值运算 |

### 5. create 一步创建含数据的表格

`create` action 支持同时创建表格并写入初始数据，避免多次调用：

```json
{
  "action": "create",
  "title": "销售数据 2026",
  "headers": ["日期", "门店", "金额", "备注"],
  "data": [
    ["2026-03-01", "门店A", 12000, ""],
    ["2026-03-02", "门店B", 8500, "周末"]
  ]
}
```

创建成功后返回 `spreadsheet_token` 和 `url`，可直接用于后续操作。

### 6. 常见操作流程

**读取特定工作表数据（标准流程）**：
1. `info` → 获取所有 sheet 的 `sheet_id` 和 `title`
2. `read` + `sheet_id` → 读取目标工作表

**追加数据（不覆盖）**：
- 直接用 `append`，工具自动找到末尾追加
- **不要用 `write`**（write 从 A1 开始覆盖）

**批量更新现有数据**：
- 先 `read` 获取现有数据，找到目标行的位置
- 用 `write` 并指定精确 range（如 `sheetId!B3:D5`）覆盖目标区域

---

## 📌 使用场景示例

### 场景 1：获取表格信息（第一步必做）

```json
{
  "action": "info",
  "url": "https://xxx.feishu.cn/sheets/sht_xxxxx"
}
```

**返回**：表格标题、`spreadsheet_token`、所有工作表列表（含 `sheet_id`、`title`、行列数）

---

### 场景 2：读取第一个工作表全部数据

```json
{
  "action": "read",
  "url": "https://xxx.feishu.cn/sheets/sht_xxxxx"
}
```

**注意**：最多返回 200 行。若 `truncated: true`，需缩小 range 分批读取。

---

### 场景 3：读取指定工作表的指定区域

```json
{
  "action": "read",
  "spreadsheet_token": "sht_xxxxx",
  "range": "0HkSJa!A1:E50"
}
```

---

### 场景 4：追加新行到表格末尾

```json
{
  "action": "append",
  "url": "https://xxx.feishu.cn/sheets/sht_xxxxx",
  "sheet_id": "0HkSJa",
  "values": [
    ["2026-03-28", "门店C", 15000, "节假日促销"],
    ["2026-03-29", "门店A", 9200, ""]
  ]
}
```

---

### 场景 5：在指定区域查找内容

```json
{
  "action": "find",
  "url": "https://xxx.feishu.cn/sheets/sht_xxxxx",
  "sheet_id": "0HkSJa",
  "find": "门店A",
  "match_entire_cell": true
}
```

**返回**：`matched_cells`（匹配的单元格地址列表，如 `["0HkSJa!A3", "0HkSJa!A7"]`）

使用正则表达式查找：

```json
{
  "action": "find",
  "spreadsheet_token": "sht_xxxxx",
  "sheet_id": "0HkSJa",
  "find": "^门店[A-Z]$",
  "search_by_regex": true,
  "range": "A1:A100"
}
```

---

### 场景 6：创建新表格并写入初始数据

```json
{
  "action": "create",
  "title": "月度采购预测",
  "folder_token": "fld_xxxxx",
  "headers": ["食材名称", "预测用量(kg)", "单价(元)", "供应商"],
  "data": [
    ["猪肉", 120, 28.5, "张记肉铺"],
    ["豆腐", 80, 4.2, "豆腐坊"]
  ]
}
```

---

### 场景 7：导出为 xlsx 并保存到本地

```json
{
  "action": "export",
  "url": "https://xxx.feishu.cn/sheets/sht_xxxxx",
  "file_extension": "xlsx",
  "output_path": "/tmp/sales_data.xlsx"
}
```

导出 CSV（必须指定 sheet_id）：

```json
{
  "action": "export",
  "spreadsheet_token": "sht_xxxxx",
  "file_extension": "csv",
  "sheet_id": "0HkSJa",
  "output_path": "/tmp/sheet1.csv"
}
```

---

## 🔍 常见错误与排查

| 错误现象 | 根本原因 | 解决方案 |
|---------|---------|---------|
| `Failed to parse spreadsheet_token from URL` | URL 格式不正确 | 检查 URL 是否为飞书电子表格链接（`/sheets/` 路径） |
| `spreadsheet has no worksheets` | 表格为空或 token 错误 | 先用 `info` action 确认表格存在且有工作表 |
| `url or spreadsheet_token is required` | 两个参数都未提供 | 至少提供 `url` 或 `spreadsheet_token` 其中之一 |
| `write row count N exceeds limit 5000` | 单次写入超过 5000 行 | 分批写入，每批 ≤ 5000 行 |
| `write column count exceeds limit 100` | 单次写入超过 100 列 | 分批写入，每批 ≤ 100 列 |
| `sheet_id is required for CSV export` | 导出 CSV 未指定工作表 | 先用 `info` 获取 `sheet_id`，再传入 export |
| `export timeout` | 导出任务 30 秒内未完成 | 表格数据量过大，尝试缩小范围或拆分工作表 |
| read 返回 `truncated: true` | 数据超过 200 行被截断 | 通过 `range` 参数分段读取（如 `sheetId!A1:Z100`，`sheetId!A101:Z200`） |
| find 返回空 `matched_cells` | 未找到匹配内容 | 检查查找字符串是否正确，`match_case` 默认区分大小写 |
| 权限错误（403/无权访问） | 用户无表格访问权限 | 确认用户已被共享该电子表格 |

---

## 📚 附录：背景知识

### A. 电子表格 vs 多维表格

| 特性 | 电子表格（Sheets） | 多维表格（Bitable） |
|------|------|------|
| 类比产品 | Excel / Google Sheets | Airtable / 数据库 |
| 数据结构 | 二维格子（行列） | 结构化记录（字段类型严格） |
| 适用场景 | 自由格式数据、报表、计算 | 结构化数据管理、CRM、项目管理 |
| 飞书工具 | `feishu_sheet` | `feishu_bitable_*` |

### B. find action 的 match_case 注意事项

飞书底层 API 的 `match_case` 语义与直觉相反：API 中 `true` 表示"不区分大小写"，`false` 表示"区分大小写"。工具层已自动取反，因此：

- `match_case: true`（默认） → 区分大小写（正常语义）
- `match_case: false` → 不区分大小写

### C. 使用限制

| 限制项 | 上限 |
|--------|------|
| 单次读取行数 | 200 行 |
| 单次写入行数 | 5,000 行 |
| 单次写入列数 | 100 列 |
| 导出轮询超时 | 30 秒（30 次 × 1 秒间隔） |
| CSV 导出 | 一次只能导出一个工作表 |
