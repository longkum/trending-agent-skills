# 图鉴维护说明

网站继续使用静态 HTML、CSS 和 JavaScript，没有框架、包管理器或运行时 API 依赖。发布文件为仓库根目录的 `index.html`；CSS、脚本和目录数据均内嵌其中。`data/repos.json` 保留为原始数据入口。

## 编辑与生成

在仓库目录运行：

```sh
python3 scripts/build.py
python3 -m http.server 8000
```

浏览 `http://localhost:8000/`。也可直接打开生成后的 `index.html` 查看与搜索目录；原始数据链接需要同目录下的 `data/repos.json`。

| 文件 | 维护内容 |
| --- | --- |
| `src/index.template.html` | 页面结构与界面文案 |
| `src/radix.css` | 从 Radix Colors 取得的原始色阶 |
| `src/styles.css` | 语义颜色令牌、布局、响应式与交互状态 |
| `src/catalog-core.js` | 文本规范、搜索、排序与 URL 状态逻辑 |
| `src/app.js` | 页面渲染与用户操作 |
| `data/repos.json` | 仓库记录的唯一数据来源 |
| `scripts/build.py` | 校验数据并生成 `index.html` |

修改 `src` 或数据后应重新运行生成命令。不要只手改 `index.html`，否则下次生成会覆盖修改。

生成器只读取原始 JSON，不重写其内容。每条仓库记录全部保留，按仓库名稳定序列化；与主摘要完全相同的英文摘要和原始描述会从网页载荷中省略以减少重复，原始 JSON 仍保留完整字段。不同摘要、原始描述、分类、星数与日期不会被改写。空摘要作为真实缺失数据保留，不生成用途说明。

生成时会检查仓库名、分类、非负整数星数、有效日期和与仓库名一致的 HTTPS GitHub 地址。遇到无效数据会停止并显示对应仓库，不会静默丢弃条目。嵌入页面的 JSON 会转义 HTML 特殊字符，仓库描述不能终止数据脚本标签或成为页面代码。

页面的“更新于”取各记录 `last_refreshed` 的最新日期，不代表所有记录在该日都已采集。新增数量以 `first_seen` 与这一日期相同为准。

## 验证

```sh
python3 -m unittest discover -s tests -p 'test_build.py' -v
node --test tests/catalog-core.test.cjs
python3 scripts/build.py --check
```

Python 检查覆盖全部数据保留、摘要精简不改变含义、非法地址和日期被拒绝，以及恶意 HTML 与模板标记不能逃逸。Node 检查覆盖目录逻辑。`--check` 比较当前数据、源文件与生成后的页面是否一致，不会修改页面。

每次涉及界面改动，还需在浏览器检查桌面和手机布局、深浅模式、键盘操作、搜索与筛选组合、分页、无结果恢复、长仓库名、空摘要和浏览器控制台。自动测试不能代替这些实际界面检查。

## 日更任务与发布

现有仓库的 `Daily update` 提交会更新生成后的 `index.html`，但其上游生成脚本和调度配置没有包含在仓库中。本改动提供新的生成入口，尚未接入或验证该外部日更任务。

维护者需要将外部任务调整为：

1. 更新 `data/repos.json`。
2. 运行 `python3 scripts/build.py`。
3. 运行上述验证，提交数据和新生成的 `index.html`。
4. 通过原有 GitHub Pages 发布方式发布。

外部任务如果继续使用旧模板重写 `index.html`，仍会覆盖本次前端改动。仅在仓库中增加生成器并不能自动修改外部任务。接入前应保留此项维护限制，不将其描述为已完成的自动更新链路。

本交付不包含远程提交、合并或线上部署。上线前应确认仓库写入权限及外部日更任务的模板入口。
