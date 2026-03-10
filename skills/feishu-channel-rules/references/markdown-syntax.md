# 飞书 Markdown 语法参考

> 本文件是飞书消息卡片支持的完整 Markdown 语法参考，供需要时查阅。

## 1. 标题

```
#### 四级标题
##### 五级标题
```

- **不支持**一二三级标题（`#`、`##`、`###`），会导致卡片显示异常
- 可用加粗替代标题效果

## 2. 换行

```
第一行\n第二行
```

## 3. 文本样式

| 语法 | 效果 |
|------|------|
| `**加粗**` | **加粗** |
| `*斜体*` | *斜体* |
| `~~删除线~~` | ~~删除线~~ |

> **注意**：加粗中间的内容只能是中文或英文，不能有中文符号或表情符号

## 4. 链接

```
[链接文本](https://www.example.com)
```

## 5. @指定人

```
<at id=id_01></at>
<at ids=id_01,id_02,xxx></at>
```

- 用户的 id 必须是用户给你的，不能瞎编
- 可能是：以 `ou_` 开头的字符串、不超过 10 位的字符串、邮箱

## 6. 超链接

```
<a href='https://open.feishu.cn'></a>
```

## 7. 彩色文本

```
<font color='green'>绿色文本</font>
```

> 颜色枚举：`neutral`, `blue`, `turquoise`, `lime`, `orange`, `violet`, `wathet`, `green`, `yellow`, `red`, `purple`, `carmine`

## 8. 文字链接

```
<a href='https://open.feishu.cn'>这是文字链接</a>
```

## 9. 图片

```
![hover_text](image_key)
```

> image_key 不支持 http 链接

## 10. 分割线

```
---
```

## 11. 标签

```
<text_tag color='red'>标签文本</text_tag>
```

颜色枚举：`neutral`, `blue`, `turquoise`, `lime`, `orange`, `violet`, `wathet`, `green`, `yellow`, `red`, `purple`, `carmine`

## 12. 有序列表

```
1. 一级列表①
    1.1 二级列表
    1.2 二级列表
2. 一级列表②
```

- 序号需在行首使用，序号后要跟空格
- 4 个空格代表一层缩进

## 13. 无序列表

```
- 一级列表①
    - 二级列表
- 一级列表②
```

- 4 个空格代表一层缩进
- `-` 后面要跟空格

## 14. 代码块

````
```JSON
{"This is": "JSON demo"}
```
````

- 支持指定编程语言解析
- 未指定默认为 Plain Text

## 15. 人员组件

```
<person id='user_id' show_name=true show_avatar=true style='normal'></person>
```

- `show_name`：是否展示用户名（默认 true）
- `show_avatar`：是否展示用户头像（默认 true）
- `style`：展示样式（`normal`：普通样式，`capsule`：胶囊样式）
- **注意**：person 标签不能嵌套在 font 中

## 16. 数字角标

```
<number_tag background_color='grey' font_color='white' url='https://open.feishu.cn' pc_url='https://open.feishu.cn' android_url='https://open.feishu.cn' ios_url='https://open.feishu.cn'>1</number_tag>
```
