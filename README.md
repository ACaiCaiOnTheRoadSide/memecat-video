# 猫 meme 小剧场

一个本地优先、无需剪辑软件的猫 Meme 短视频创作台。输入故事后生成分镜，选择猫咪演员、布置背景、编辑字幕与图层，并直接在浏览器中导出带声音的 MP4。

- 在线体验：https://kcn88890.sc.monkeycode-ai.online/
- 创作台：https://kcn88890.sc.monkeycode-ai.online/cat-meme-theater/
- 代码仓库：https://github.com/ACaiCaiOnTheRoadSide/-meme-

## 功能

- AI 扩写故事、拆分分镜与匹配演员
- 支持数百个猫咪、动物、人物与特效素材（按需从素材库获取）
- 多分镜时间轴，支持新增、删除、排序和调节时长
- 单幕多演员图层，可拖动位置、缩放、静音和调整层级
- AI 背景生成，也可使用办公室、街道、舞台等内置背景
- 字幕内容与位置实时编辑
- 支持 `9:16`、`16:9`、`1:1` 三种画面比例
- 浏览器本地导出 H.264 + AAC MP4
- 项目自动保存，刷新后恢复编辑进度
- 已完成的视频保存在 IndexedDB，刷新后仍可继续下载
- 独立演员资料库，支持管理员维护素材信息
- 落地页案例剧场，可展示人工精选案例

## 为什么不在服务端使用 FFmpeg

视频合成与编码在用户浏览器中完成，而不是交给 Node 服务：

```text
Canvas 实时画面
  → MediaRecorder
  → H.264 视频 + AAC 音频
  → MP4 Blob
  → IndexedDB
  → 本地下载
```

这样做有几个好处：

- 多个用户可以同时导出，不争抢服务器 CPU 和内存；
- 视频和成片不需要上传到服务器；
- 服务端无需安装 FFmpeg；
- 容器内存不会随视频时长、分辨率或演员数量增长；
- 导出完成后即使刷新页面，也能从 IndexedDB 恢复下载入口。

当前主要支持最新版 Chrome 和 Edge。浏览器不支持 `MediaRecorder(video/mp4)` 时，创作台会给出明确提示。

## 环境要求

- Node.js 20.12 或更高版本
- 最新版 Chrome 或 Edge（用于导出 MP4）
- 可选：Agnes API Key（用于 AI 故事、分镜、选角和背景生成）

不需要安装 FFmpeg，也没有第三方 npm 运行依赖。

> 演员视频与海报体积较大，不随 Git 仓库分发。首次运行前请按下方说明获取素材。

## 本地运行

### 1. 获取代码

```bash
git clone git@github.com:ACaiCaiOnTheRoadSide/-meme-.git
cd -- -meme-
```

### 2. 创建配置

```bash
cp config.example.yml config.yml
```

编辑 `config.yml`：

```yaml
server:
  host: "127.0.0.1"
  port: 4173

agnes:
  api_key: "YOUR_AGNES_API_KEY"

admin:
  token: "CHANGE_THIS_ADMIN_TOKEN"
```

> `config.yml` 已加入 `.gitignore`。不要把真实 API Key 或管理令牌提交到仓库。

### 3. 获取演员素材

打开百智设计素材库，登录后搜索并下载需要的猫咪、动物、人物或特效素材：

https://design-prompt.app.baizhi.cloud/catalog/assets

将下载的素材放入对应目录：

```text
web/public/cat-meme-theater/assets/clips/          视频素材
web/public/cat-meme-theater/assets/posters/        原始缩略图
web/public/cat-meme-theater/assets/posters-keyed/  抠像缩略图
```

仓库保留了 `clip-catalog.json` 和 `clip-catalog.js`，其中记录了创作台期望的文件名、素材说明和标签。下载或整理素材时，请让路径与索引保持一致。

已授权的客户端也可以直接调用素材查询接口：

```http
GET https://design-prompt.app.baizhi.cloud/api/v1/catalog/assets?q=猫&page=1&page_size=100
```

该接口需要登录态或平台提供的授权信息；未认证请求会返回 HTTP 401。请根据自己的百智账号/API 配置传递凭据，不要把凭据写入仓库。

### 4. 启动

```bash
npm start
```

也可以使用检查配置后再启动的脚本：

```bash
./start-with-agnes.sh
```

打开：

```text
http://localhost:4173/                           落地页
http://localhost:4173/cat-meme-theater/          创作台
http://localhost:4173/cat-meme-theater/library.html  演员资料库
```

## 数据与隐私

| 数据 | 存储位置 |
|---|---|
| 当前项目 | `localStorage` + `.data/projects/<client-id>.json` |
| 浏览器导出的 MP4 | 当前浏览器 IndexedDB |
| AI 生成背景 | `web/public/cat-meme-theater/generated/<client-id>/` |
| 素材索引与内置背景 | `web/public/cat-meme-theater/assets/` |
| 演员视频与海报 | 从[百智设计素材库](https://design-prompt.app.baizhi.cloud/catalog/assets)下载到 `assets/clips/`、`assets/posters/`、`assets/posters-keyed/` |
| 人工精选案例 | `web/public/cat-meme-theater/showcase/` |

浏览器导出的 MP4 不会上传到服务端。使用 AI 功能时，故事文本、分镜提示词或背景提示词会发送到配置的 Agnes API；不使用 AI 功能时，可完全使用内置素材和背景手动创作。

平台部署环境可能没有持久化磁盘，因此服务端保存的项目和 AI 背景在容器重启后可能丢失；浏览器中的 `localStorage` 与 IndexedDB 不受该容器重启影响。

## 案例剧场

落地页的案例区由 `GET /api/showcase` 驱动。将精选视频放入：

```text
web/public/cat-meme-theater/showcase/
```

支持 `.mp4`、`.webm`、`.mov`、`.m4v`。文件按名称排序，可以添加数字前缀控制顺序：

```text
01-菜鸟猫的第一天.mp4
02-深夜机房猫.mp4
```

需要自定义标题和描述时，在同目录创建 `cases.json`。详细格式见 [`showcase/README.md`](web/public/cat-meme-theater/showcase/README.md)。

浏览器本地导出的作品不会自动上传或进入案例区，需要由作者自行挑选后放入 `showcase/`。

## 素材获取与管理

大型演员素材不随 Git 仓库提交，请从以下地址按需获取：

https://design-prompt.app.baizhi.cloud/catalog/assets

素材查询 API：

```text
GET https://design-prompt.app.baizhi.cloud/api/v1/catalog/assets
```

API 支持使用 `q`、`page`、`page_size` 等参数搜索和分页，并需要平台授权。

本地演员素材与索引位于：

```text
web/public/cat-meme-theater/assets/
├── clips/            视频素材
├── posters/          原始缩略图
├── posters-keyed/    抠像缩略图
├── clip-catalog.json 素材元数据
└── clip-catalog.js   浏览器加载版本
```

打开演员资料库后，可以使用 `config.yml` 中的 `admin.token` 解锁管理功能，修改素材名称、描述与标签，或删除素材。

## 目录结构

```text
.
├── server.mjs                         Node HTTP 服务与 API
├── package.json                       启动脚本与 Node 版本要求
├── config.example.yml                 配置模板
├── start-with-agnes.sh                配置检查与启动脚本
└── web/public/
    ├── index.html                     产品落地页
    └── cat-meme-theater/
        ├── index.html                 创作台
        ├── library.html               演员资料库
        ├── assets/                    背景与素材索引；大型演员素材需另行下载
        └── showcase/                  人工精选案例
```

## 主要 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/clips` | 获取演员素材目录 |
| `GET` | `/api/showcase` | 获取案例剧场内容 |
| `GET/PUT` | `/api/project` | 读取或保存项目 |
| `POST` | `/api/expand-story` | AI 扩写故事 |
| `POST` | `/api/generate-storyboard` | AI 生成分镜 |
| `POST` | `/api/match-clip` | AI 匹配演员 |
| `POST` | `/api/generate-background` | AI 生成背景 |
| `POST` | `/api/export-video` | 已停用，返回 HTTP 410；MP4 改由浏览器导出 |

## 安全说明

- `config.yml`、`.data/`、大型演员素材、用户生成背景和导出目录默认不会提交到 Git；
- 所有用户输入在服务端边界进行基本长度和路径校验；
- 素材管理操作需要管理员令牌；
- 浏览器导出不会占用服务端视频编码资源；
- 不要在公开仓库、截图或日志中暴露 Agnes API Key 和管理令牌。

## 开发检查

```bash
node --check server.mjs
npm start
```

浏览器导出回归应至少确认：

- 输出文件为 MP4；
- 视频轨为 H.264；
- 音频轨为 AAC；
- 三种画面比例尺寸正确；
- 服务端没有收到 `/api/export-video` 请求；
- 刷新后可以恢复已完成视频的下载入口。
