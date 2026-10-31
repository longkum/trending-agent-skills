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
| `scripts/collect_stars.py` | 按 UTC 日采集真实 GitHub Star 数量 |
| `scripts/growth_metrics.py` | 计算真实快照窗口净增，生成历史曲线数据 |
| `data/star-history/YYYY-MM-DD.json` | 每日 Star 快照，使用稳定仓库 ID |
| `data/star-growth.json` | 前端读取的历史和涨星指标 |
| `src/growth-core.js` / `src/growth-app.js` | 排行榜、参考榜、趋势图逻辑 |
| `.github/workflows/star-growth.yml` | 每日采集并写入仓库 |

修改 `src` 或数据后应重新运行生成命令。不要只手改 `index.html`，否则下次生成会覆盖修改。

生成器只读取原始 JSON，不重写其内容。每条仓库记录全部保留，按仓库名稳定序列化；与主摘要完全相同的英文摘要和原始描述会从网页载荷中省略以减少重复，原始 JSON 仍保留完整字段。不同摘要、原始描述、分类、星数与日期不会被改写。空摘要作为真实缺失数据保留，不生成用途说明。

生成时会检查仓库名、分类、非负整数星数、有效日期和与仓库名一致的 HTTPS GitHub 地址。遇到无效数据会停止并显示对应仓库，不会静默丢弃条目。嵌入页面的 JSON 会转义 HTML 特殊字符，仓库描述不能终止数据脚本标签或成为页面代码。

页面的“更新于”取各记录 `last_refreshed` 的最新日期，不代表所有记录在该日都已采集。新增数量以 `first_seen` 与这一日期相同为准。

## 验证

```sh
python3 -m unittest discover -s tests -p 'test*.py' -v
node --test tests/*.test.cjs
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

## 涨星榜数据口径与上线现状

- 真实 Star 历史采集已启用：GitHub Actions 工作流 `Daily GitHub Star history` 每天 UTC 06:17 运行，另支持手动触发。每日生成 `data/star-history/YYYY-MM-DD.json`，按 GitHub repository ID 保留更名后的连续性。首次运行已成功，后续按天积累。
- 24 小时、7 天、30 天正式榜及趋势曲线均需要独立采集的真实历史快照；没有足够窗口跨度就显示数据不足，不推算、不补零。
- 首页「7 天涨星 / 7 天增长率」在历史不足时展示**清晰标为参考值**的现有目录 `gain_7d`。该值未经本站连续日快照复核，仅收录相对目录最新日期近 3 个自然日更新、且有非零变动的项目；不会写入历史曲线。
- 由 `GITHUB_TOKEN` 提交的日快照可能不会自动触发 Pages 构建，因此前端优先读取公开 GitHub 主分支中最新的 `data/star-growth.json`，访问异常时回退到 Pages 本地文件。需要重新发布嵌入目录和静态统计时，仍要确保触发 GitHub Pages 部署。
- 外部 `Daily update` 任务仍需维护者把旧模板发布流程改为更新 `data/repos.json` 后运行 `python3 scripts/growth_metrics.py`、`python3 scripts/build.py`、测试和发布，避免覆盖本次图鉴新版。

