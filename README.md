# Mixamo 动画批量下载器（Chrome 扩展 / Manifest V3）

按 **当前 Mixamo 页面已有的筛选/搜索条件** 批量下载动画：单任务顺序下载、已下载自动跳过、
失败自动重试、可暂停/继续/停止，下载参数默认与「DOWNLOAD SETTINGS」对话框一致。

---

## 1. 安装

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `browser-plugin/`
4. 工具栏出现橙色下载图标即安装成功

> 需要 Chrome 116 及以上。扩展 ID 由本目录的绝对路径决定，移动目录后需要重新加载。

## 2. 首次使用（重要）

Chrome 扩展**无法**把下载写到任意绝对路径（`chrome.downloads` 的 `filename` 只能相对于浏览器下载目录），
所以扩展用「文件系统访问」授权一个真实目录，然后直接流式写入。

1. 点击扩展图标 → **设置**（或右键图标 → 选项）
2. 在「1. 保存目录」里点 **选择目录…**，选中 `D:\sgames\animation-ai\mixamo`，确认授权
3. 点 **测试写入** 可以立刻确认目录真的可写

### 授权失效怎么办（Chrome 重启后常见）

File System Access 的授权是**会话级**的：重启 Chrome 之后，已保存的目录句柄还在，
但权限会被浏览器降级成「询问」。这是浏览器的安全策略，扩展无法绕过。表现是设置页显示：

> 需要重新授权：“mixamo”

此时点一次 **重新授权** 即可恢复（**不需要**重新选目录）。扩展在这种情况下会
**暂停任务并提示**，不会偷偷把文件写到别的目录去。

如果你不想每次重新授权，也可以把保存方式改成「浏览器下载目录 / mixamo」——
只是那个目录由 Chrome 设置决定，扩展无法指定绝对路径（下载完成后日志会打印文件的真实绝对路径）。

## 3. 使用

1. 在 `https://www.mixamo.com/` 上用站点自己的搜索框 / 筛选器选好要的动画集合
   （例如搜索 `Aiming Rifle`、切到 Animations、翻到某一页）
2. 点扩展图标 → **开始**
   - 扩展会按当前页面的 hash 查询参数（`query` / `type` / 分页等）去拉取结果列表
   - 抓取范围默认「当前筛选的全部结果」；可在设置里改成「仅当前页」
3. 之后就是自动的：**详情 → 服务器生成 → 轮询 → 写盘 → 记录**，一次一个
4. 按钮说明
   | 按钮 | 作用 |
   | --- | --- |
   | 开始 | 按当前页面筛选条件重建队列并开跑（已完成的不再下载） |
   | 暂停 | 当前这一条会先跑完，之后不再开始新条目 |
   | 继续 | 从暂停处接着跑 |
   | 停止 | 停止调度；队列保留，再点「开始/继续」可恢复 |
   | 重试失败项 | 把失败条目的重试计数清零重新排队 |
   | 清空队列/记录 | 清空队列与「已下载」记录（磁盘文件不删） |

## 4. 下载参数

默认值与截图里的对话框完全一致：

| 下拉框 | 默认值 | 接口取值 |
| --- | --- | --- |
| Format | FBX Binary(.fbx) | `fbx7_2019` |
| Skin | With Skin | `true` |
| Frames per Second | 60 | `60` |
| Keyframe Reduction | none | `0` |

同时支持 FBX ASCII / FBX for Unity / FBX 7.4 / FBX 6.1 / Collada(.dae)。

其它可调项（设置页）：

- **抓取范围**：当前筛选的全部结果（遍历所有页、按 id 去重）/ 仅当前页
- **动画包(MotionPack)**：默认跳过（导出结果是 zip，且 payload 形状不同）
- **条目间隔**：默认 1500ms，Mixamo 有 429 限流，不建议低于 1000ms
- **失败重试次数**：默认 3
- **导出轮询间隔 / 单条超时 / 每页条数**

## 5. 工作原理

页面上的「Download」并**不是**在浏览器里用 JS 生成文件，而是走服务端异步导出：

```
POST /api/v1/animations/export        -> 202 + { uuid }
GET  /api/v1/characters/<uuid>/monitor -> status=completed + job_result（S3 签名直链）
```

扩展在 Service Worker 里复刻了这条链路（`src/lib/api.js`），因此：

- 不需要操作页面 DOM，不受 React 重渲染影响，速度也快得多
- 鉴权用页面 `localStorage.access_token`（由内容脚本读取回传）+ 固定请求头 `X-Api-Key: mixamo2`
  （该 key 是 Mixamo 网页端公开下发的客户端标识，**非机密**，见第 11 节）
- 导出目标角色取 `/api/v1/characters/primary`（即你在站点上最后选定的角色）
- `gms_hash.params` 必须是「逗号分隔的数字串」（相对默认值的偏移），传名字-值数组会让服务端生成失败；
  本扩展统一填 `0`（即动画默认形态），并单独带 `overdrive: 0`

状态、队列、已下载记录都存在 `chrome.storage.local`，每个条目处理完立即落盘，所以被打断后可恢复。

## 6. 目录结构

```
browser-plugin/
├── manifest.json
├── icons/                     # 由 tools/make-icons.mjs 生成
└── src/
    ├── background.js          # Service Worker：调度循环、队列、记录、消息路由
    ├── lib/
    │   ├── api.js             # Mixamo 接口客户端（目录/详情/导出/轮询、429 退避）
    │   ├── fs.js              # 落盘：目录句柄流式写入 + chrome.downloads 回退
    │   └── store.js           # chrome.storage 状态层与默认设置
    ├── content/mixamo.js      # 只读：回传 token 与当前页面筛选参数
    ├── popup/                 # 控制面板：状态、进度、开始/暂停/停止、日志
    └── options/               # 设置页：保存目录授权、下载参数、频率、队列管理
```

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 「没有找到 mixamo.com 标签页」 | 先打开并登录 `https://www.mixamo.com/` |
| 「尚未登录（没有 access_token）」 | 在该标签页完成 Adobe 登录后重试 |
| 「登录状态失效，任务已暂停」 | token 约 24h 过期；在站点重新登录后点「继续」 |
| 「保存目录授权已失效…已暂停」 | Chrome 重启把目录授权降级了；设置页点 **重新授权**（见第 2 节），然后点「继续」 |
| 「还没有授权保存目录…已暂停」 | 设置页点「选择目录…」选中目标目录 |
| 提示被限流（429） | 属正常保护；扩展按 `Retry-After` 指数退避（最长 5 分钟）后自动重试，也可把条目间隔调大 |
| 某个动画一直失败 | 个别素材缺少 `gms_hash`（例如动画包）；可在设置里打开「一并下载(zip)」或跳过 |
| 想知道文件到底写到哪了 | 看日志：`✔ 名称 → <绝对路径> (大小)`。fs 模式显示文件名（浏览器不暴露绝对路径），downloads 模式显示完整路径 |

## 8. 已知限制

- 仅支持 Chrome（MV3 + File System Access）
- 单任务串行：Mixamo 的 monitor 是按角色维度的，并发导出会互相干扰，故不做并发
- 「停止/暂停」不会中断已经在服务器上排队的导出，当前这一条会先完成
- 目录授权需要用户手动点一次（浏览器安全限制，无法由扩展代为授权）；
  Chrome 重启后授权会降级，需在设置页点一次「重新授权」
- 使用非公开接口，Mixamo 改版后可能需要同步调整 `src/lib/api.js`

## 9. 已完成的真机验证

在 Chrome 155 + 真实 Adobe 账号下实测通过：

- 按页面筛选条件抓取（`query=Aiming Rifle`，24 条/页 → 18 个动画，自动剔除 6 个动画包）
- 连续下载 4 条，全部成功（1.8–2.2 MB/条，约 6 秒/条），文件头为 `Kaydara FBX Binary`
- 目录句柄流式写入路径单独验证：2,241,040 字节完整落盘到 `D:\sgames\animation-ai\mixamo`
- 去重：同一筛选条件下再次「开始」，待下载 0、不重复下载
- 暂停/继续/停止：暂停后不再开始新条目；抓取列表期间点暂停不会被启动覆盖
- 失败重试、429 退避、登录失效自动暂停等分支均按预期工作

## 10. 开发 / 自检工具

仓库根目录的 `tools/` 里有几个无第三方依赖的脚本：

| 脚本 | 作用 |
| --- | --- |
| `tools/check-plugin.mjs` | 自检：manifest 合法性、文件引用、图标尺寸、HTML/JS 的 DOM id 一致性、JS 语法 |
| `tools/test-fs-unit.mjs` | `fs.js` 单元测试：未授权 / 授权失效 / 正常写入 / 目录自检 / 重新授权 / HTTP 失败（含真实 IndexedDB 语义的桩） |
| `tools/make-icons.mjs` | 重新生成 `icons/*.png` |
| `tools/cdp.mjs` | 极简 Chrome DevTools Protocol 客户端（`targets` / `eval` / `nav` / `newtab` / `shot` / `browser`） |
| `tools/sw-run.mjs` | 等 MV3 Service Worker 存活时在其上下文里执行脚本（MV3 worker 空闲即退出，必须同连接抢抓） |
| `tools/test-fs-write.mjs` | 用真实导出直链 + Node 可写流验证 `fs.js` 的流式写盘路径 |

自检命令：

```bash
node tools/check-plugin.mjs --dir browser-plugin
node tools/test-fs-unit.mjs
```

## 11. 敏感信息与仓库卫生

### 仓库内不含凭据（已扫描确认）

对全部受版本控制的文件做过扫描，结论：**没有** API 令牌、密码、私钥、`.env` 文件、
IP 地址、个人绝对路径或邮箱地址；`icons/*.png` 也不含 `tEXt`/`iTXt`/`eXIf` 等元数据块。
唯二的「类敏感」字符串及其判定如下。

### `X-Api-Key: mixamo2` —— 公开标识，非机密

`src/lib/api.js` 里的 `API_KEY` 是 Mixamo 网页端公开下发的客户端标识，随前端 bundle
发给每一位访客（DevTools → Network 里任意 `/api/v1` 请求都能看到），因此硬编码不构成
泄露。代码内已就地注释说明；若将来它被收紧为真密钥，必须改为构建期注入。

### `access_token` —— 仅在运行时流转

真正的凭据是用户的 OAuth `access_token`，由内容脚本从 mixamo.com 标签页的
`localStorage` 读取后回传，只在 Service Worker 内存与 `chrome.storage.local` 中短暂停留，
**不写日志、不落磁盘、不进仓库**。

### `.gitignore` 覆盖范围

`.gitignore` 按误提交后果分级，重点拦截：`.env`/`*.key`/`*.pem`/`*.p12` 等凭据文件、
`mixamo/` 与 `*.fbx` 等下载产物、`node_modules/`/`dist/` 等构建产物、日志与缓存。

### 提交身份

本仓库使用 **repo 级**身份（不影响全局配置）：

```bash
git config --local user.name  "huanghaiyang"
git config --local user.email "huanhai24@sina.com"
```

> 首次提交前请确认该邮箱是你要永久写进历史的地址 —— commit 元数据一旦推送即公开，
> 想要清除只能改写历史。

### 复扫命令

改动后可用下面两条命令重新确认（无需安装任何依赖）：

```bash
# 1) 扫凭据特征。注意必须加 --untracked：纯 git grep 只搜已跟踪文件，
#    在尚无提交的仓库里会什么都不返回（假阴性）。
#    预期输出只有一条：src/lib/api.js 的公开标识 mixamo2。
git grep --untracked -nIiE "(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|passwd|password)[[:space:]]*[:=][[:space:]]*['\"][^'\"]{6,})"

# 2) 确认敏感路径确实被忽略（应回显命中的 .gitignore 规则行）
git check-ignore -v .env node_modules/x dist/x mixamo/a.fbx secrets/k.pem
```

