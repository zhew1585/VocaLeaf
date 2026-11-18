# VocaLeaf（拾页）

把自己的英文电子书变成有声书，边听边拾起想学的句子。
领域词汇见 [CONTEXT.md](CONTEXT.md)，需求见 [docs/prd-mvp.md](docs/prd-mvp.md)，架构决策见 [docs/adr/](docs/adr/)。

## 起栈

前提：装好 Docker（Docker Desktop 或 Docker Engine + Compose v2）。
不需要任何云账号。

```sh
docker compose up --build
```

首次启动会构建三个镜像并拉取 Kokoro（约 4.5GB），之后几秒即可就绪。
打开 http://localhost:8080 ，选择一本无 DRM 的 EPUB（例如 [Standard Ebooks 的 Pride and Prejudice](https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice)）并上传。
页面跳到书籍详情，书先显示【解析中】，解析完成后变为【生成中】并列出全部章节和每章句子数。

停止：`docker compose down`；连数据一起清空：`docker compose down -v`。

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_PORT` | `8080` | 网页端口 |
| `WORKER_TOKEN` | `dev-worker-token-change-me` | worker 调用 `/api/internal` 的共享密钥，上线必须改 |

## 组成

| 服务 | 说明 |
| --- | --- |
| `web` | Vite + React SPA，由 nginx 提供，并把 `/api` 反向代理到 API |
| `api` | TypeScript（Hono），唯一读写数据库的组件；OpenAPI 文档在 `/api/openapi.json` |
| `worker` | Python，无状态；向 API 领取任务、从对象存储读原文件、把结果回调给 API，不连数据库 |
| `postgres` | 数据库，只与 API 在同一网络 |
| `storage` | S3 兼容对象存储（RustFS） |
| `kokoro` | Kokoro-FastAPI（CPU），音频生成在 #2 接入 |

对象存储只通过 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 访问。
换成 Cloudflare R2：把这五个变量改成 R2 的值（`S3_REGION=auto`），并去掉 `storage` 服务。

登录在 #6 实现。
目前所有请求都以一个固定的开发身份进行，见 [api/src/dev-identity.ts](api/src/dev-identity.ts)。

## 开发与测试

```sh
npm ci                     # api 与 web 的依赖（npm workspaces）
npm test                   # api（PGlite 内存 Postgres）与 web 的测试
npm run typecheck
(cd worker && uv sync && uv run pytest && uv run ruff check && uv run pyright)

docker compose up -d --build
npm run test:e2e           # 针对运行中的栈的端到端功能测试
```

改了 `api/src/db/schema.ts` 之后运行 `npm run db:generate -w api` 生成迁移；API 启动时自动执行迁移。
