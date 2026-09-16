# picgo-plugin-original-convert

面向 PicGo / PicList 的图床无关插件：通过当前激活的 uploader 同时上传原图与 WebP 派生图，但最终只向调用方返回 WebP（或无需转换的透传图片）。

运行环境要求 Node.js 20.9.0 或更高版本。

## V1 行为

| 输入 | 实际上传 | 最终返回 |
| --- | --- | --- |
| JPG / JPEG | 原 JPG/JPEG + 有损 WebP | WebP |
| PNG | 原 PNG + 默认无损 WebP | WebP |
| WebP | 原 WebP（不二次编码） | WebP |
| GIF / SVG / AVIF / 其他 | 原文件（透传） | 原文件 |

- 派生图继承 PicList 已确定的目录与 basename，只把扩展名改为 `.webp`。
- 不读取 bucket、密钥、endpoint、域名或 uploader 类型。
- 支持批量上传并按原始输入顺序返回结果。
- 上传前检测文件名冲突；上传后检查每个 original / derived 是否都得到标准 `imgUrl`。
- 转换全部在内存中进行，不产生临时图片文件。
- 某个文件上传失败时整批报错，但不会调用图床 API 回滚已上传对象。

## 安装

发布到 npm 后可在 PicList 插件页搜索 `original-convert`。本地开发或私有部署可在插件目录中安装此项目，随后重启 PicList。

项目本地验证：

```bash
npm install && npm test
```

## 配置

```json
{
  "picgo-plugin-original-convert": {
    "enabled": true,
    "jpegQuality": 82,
    "webpEffort": 4,
    "pngLossless": true,
    "maxInputSizeMB": 50,
    "concurrency": 2
  }
}
```

`jpegQuality` 范围为 1–100；`webpEffort` 为 0–6；`concurrency` 为 1–16。

## Uploader 兼容边界

兼容遵循标准 PicGo `ctx.output → uploader → ctx.output` 模型、支持一次上传多个 output 项并为每项返回 `imgUrl` 的 uploader。

插件优先使用内部标记匹配上传结果；若第三方 uploader 重建对象并丢弃自定义字段，则回退到精确 `fileName` 匹配。若 uploader 同时丢弃标记与文件名、合并结果或只返回部分项目，插件会明确报兼容性错误，不会猜测或静默成功。

## “原图”的定义

原图对象的 Buffer 不会被本插件修改或重新编码。这里的原图指本插件在 `beforeUpload` 阶段收到的字节；如果更早运行的 PicList 预处理或其他插件已经修改图片，这个插件无法恢复 HTTP 请求刚进入 PicList 时的原始字节。

## 已知限制

- V1 只为 JPG/JPEG 和 PNG 生成派生图片。
- 不提供跨图床事务回滚；失败后可能留下孤儿对象。
- 两个并发上传批次若使用完全相同的文件名，且 uploader 又删除所有内部标记，无法可靠区分；标准 uploader 保留对象字段时不受影响。
- 请避免同时启用其他会在 `beforeUpload` 中替换 Buffer 或文件名的转换插件。

## License

MIT
