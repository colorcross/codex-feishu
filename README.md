# Codex Feishu Bridge

将飞书消息桥接到 Codex CLI，支持：

- 全局安装与项目级配置
- 飞书长连接模式与 Webhook 模式
- Codex 会话续接与项目路由
- 会话状态持久化与多会话历史切换
- 消息幂等去重与 run_id 审计链路
- 启动预检、优雅停机、实例锁
- 运行超时、取消、stale/orphaned run 恢复
- 飞书发送失败重试
- 飞书远端诊断与手工发信
- Prometheus 指标导出
- 后台服务管理命令 `serve status|stop|logs|ps`
- 可选的 Codex skill 安装

## 设计目标

- `Prod` 交付标准：不是一次性脚本，而是可部署、可配置、可排障的正式项目。
- 本地优先：用飞书长连接模式支持无公网本机接入。
- 生产可扩展：切到 Webhook 后支持交互卡片回调。
- 项目隔离：同一个飞书入口可以路由到多个仓库、不同 Codex profile、不同 sandbox。

## 运行模式

### 1. `long-connection`

适合本机直接跑服务：

- 不需要公网回调 URL
- 收消息成本最低
- 适合个人开发和内网环境
- 限制：官方 SDK 文档说明长连接只支持 event subscription，不支持 callback subscription，所以卡片按钮不能作为主交互方式

### 2. `webhook`

适合正式生产部署：

- 支持飞书事件订阅
- 支持交互卡片回调
- 适合团队共用的桥接服务
- 需要公网可访问的回调地址

## 快速开始

先复制环境变量模板：

```bash
cp .env.example .env
```


### 1. 安装

```bash
pnpm install
pnpm build
```

全局安装时：

```bash
npm i -g .
```

一键安装并生成全局配置时：

```bash
bash scripts/install.sh
```

说明：

- 会全局安装 `codex-feishu`
- 会生成 `~/.codex-feishu/config.toml`
- 会把当前仓库绑定为默认项目
- 之后大多数命令都可以直接执行，不需要再带 `--config`

### 2. 初始化配置

全局模式：

```bash
codex-feishu init --mode global
```

项目模式：

```bash
cd /path/to/repo
codex-feishu init --mode project
```

### 3. 配置飞书环境变量

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_ENCRYPT_KEY=xxx
export FEISHU_VERIFICATION_TOKEN=xxx
```

### 4. 绑定项目

```bash
codex-feishu bind repo-a /abs/path/to/repo-a --config ~/.codex-feishu/config.toml
codex-feishu bind repo-b /abs/path/to/repo-b --config ~/.codex-feishu/config.toml
```

### 5. 运行检查

```bash
codex-feishu doctor
codex-feishu doctor --json
codex-feishu doctor --remote
codex-feishu feishu inspect
```

### 6. 启动服务

```bash
codex-feishu serve
```

说明：

- `serve` 默认会先执行启动预检，发现阻塞错误会直接退出
- 如需后台运行并立即返回 shell，可用 `codex-feishu serve --detach`
- 如需临时跳过预检，可用 `codex-feishu serve --skip-doctor`
- 后台运行后可用 `codex-feishu serve status|logs|ps|stop` 管理进程
- 同一个状态目录默认只允许一个服务实例持有锁，避免重复消费和重复回复
- 如配置了 `service.metrics_port`，会额外启动管理端口并暴露 `/metrics`

### 7. 生成用户级服务文件

查看模板：

```bash
codex-feishu service print --config ~/.codex-feishu/config.toml
```

写入用户级服务定义：

```bash
codex-feishu service install --config ~/.codex-feishu/config.toml
```

然后按输出提示执行：

- macOS: `launchctl bootstrap ...`
- Linux: `systemctl --user enable --now ...`

## 飞书侧交互命令

- `/help` 查看帮助
- `/projects` 列出可用项目
- `/project <alias>` 切换当前项目
- `/status` 查看当前项目会话
- `/new` 为当前项目切到新会话
- `/cancel` 取消当前项目正在运行的任务
- `/session list` 查看当前项目保存过的会话历史
- `/session use <thread_id>` 切到指定历史会话
- `/session new` 让下一条消息新开会话
- `/session drop [thread_id]` 删除指定或当前会话
- 直接发文本：进入当前项目的 Codex 会话
- `codex-feishu audit tail --limit 20` 查看最近审计事件

## 配置文件

默认路径：

- 全局：`~/.codex-feishu/config.toml`
- 项目：`.codex-feishu/config.toml`

示例：

```toml
version = 1

[service]
default_project = "default"
reply_mode = "text"
emit_progress_updates = false
idempotency_ttl_seconds = 86400
session_history_limit = 20
log_tail_lines = 100
reply_quote_user_message = true
metrics_host = "127.0.0.1"
# metrics_port = 9464

[codex]
bin = "codex"
# shell = "/bin/zsh"
# pre_exec = "proxy_on"
default_sandbox = "workspace-write"
run_timeout_ms = 600000
bridge_instructions = "Reply concisely for Feishu."

[storage]
dir = "~/.codex-feishu/state"

[security]
allowed_project_roots = []
require_group_mentions = true

[feishu]
app_id = "env:FEISHU_APP_ID"
app_secret = "env:FEISHU_APP_SECRET"
# dry_run = true
transport = "long-connection"
port = 3333

[projects.default]
root = "/abs/path/to/repo"
session_scope = "chat"
mention_required = true
profile = "default"
```

补充说明：

- `service.reply_quote_user_message = true`
  - 优先使用飞书原生 `message reply` 回复触发消息
  - 只有在拿不到原始 `message_id` 时，才退回文本前缀引用
- `feishu.allowed_chat_ids`
  - 私聊 `chat_id` 白名单，空数组表示不限制
- `feishu.allowed_group_ids`
  - 群聊 `chat_id` 白名单，空数组表示不限制
- `security.require_group_mentions = true`
  - 群聊默认必须 `@机器人` 才会触发

## Codex Skill

项目内置了一个可选 skill，安装后可以在本地 Codex 会话中统一飞书桥接上下文：

```bash
codex-feishu codex install-skill
```

该命令会：

- 复制 `skills/codex-feishu-session`
- 安装到 `~/.codex/skills/<name>`
- 更新 `~/.codex/config.toml` 中的 `skills.config`

## 开发命令

```bash
pnpm dev -- --help
pnpm typecheck
pnpm test
pnpm build
pnpm demo:up
pnpm demo:smoke
pnpm demo:down
```

## 文档

- [架构设计](./docs/architecture.md)
- [部署说明](./docs/deployment.md)
- [安全与运维](./docs/security.md)

## 运维命令

- `codex-feishu service print` 打印用户级服务模板
- `codex-feishu service install` 写入服务文件
- `codex-feishu service uninstall` 删除服务文件
- `codex-feishu doctor` 运行配置与运行前检查
- `codex-feishu doctor --json` 以机器可读 JSON 输出检查结果
- `codex-feishu doctor --remote` 增加飞书租户侧可用性检查
- `codex-feishu serve status` 查看 bridge 主进程和活跃运行数
- `codex-feishu serve logs --lines 100` 查看最新日志
- `codex-feishu serve ps` 查看活跃 Codex 运行
- `codex-feishu serve stop --force` 停掉后台 bridge
- `codex-feishu feishu inspect` 检查 token / app / bot / IM 可用性
- `codex-feishu feishu send-test --receive-id-type <type> --receive-id <id>` 发送真实测试消息
- `codex-feishu audit tail --limit 20` 查看最近审计事件
- `examples/prometheus.yml` 和 `examples/alerts.yml` 可直接作为 Prometheus 抓取与告警起点
- `examples/docker-compose.observability.yml` 可一键拉起 Prometheus + Alertmanager + Grafana

## 本地 Webhook 回放

适合在没有真实飞书流量时验证 webhook 链路：

```bash
codex-feishu serve --config ~/.codex-feishu/config.toml
```

另一个终端回放文本消息：

```bash
codex-feishu webhook replay-message \
  --url http://127.0.0.1:3333/webhook/event \
  --chat-id oc_demo \
  --actor-id ou_demo \
  --text "帮我看一下这个项目的当前状态"
```

回放卡片动作：

```bash
codex-feishu webhook replay-card \
  --url http://127.0.0.1:3333/webhook/card \
  --chat-id oc_demo \
  --actor-id ou_demo \
  --open-message-id om_demo \
  --action status \
  --project-alias default \
  --conversation-key tenant-local/oc_demo/ou_demo
```

也可以直接跑一条完整烟测：

```bash
codex-feishu webhook smoke --base-url http://127.0.0.1:3333
```

## 本地 Demo Stack

项目内置了一套开发脚本，会：

- 自动生成临时 webhook 配置
- 启动本地 bridge
- 可选拉起 Prometheus + Alertmanager + Grafana
- 执行 smoke 验证

命令：

```bash
pnpm demo:up
pnpm demo:status
pnpm demo:smoke
pnpm demo:down
```

默认运行目录：

- 配置与状态：`.tmp/dev-stack/`
- bridge 日志：`.tmp/dev-stack/bridge.log`
- dev stack 会自动启用 `feishu.dry_run = true`，因此回复只写日志和指标，不会真的发往飞书

如果只想启动 bridge，不拉 observability：

```bash
bash scripts/dev-stack.sh up --no-observability
```

## 健康检查

Webhook 模式下内置：

- `GET /healthz`
- `GET /readyz`

返回：

```json
{"ok":true,"transport":"webhook"}
```

若配置了 `service.metrics_port`，管理端口还会暴露：

- `GET /metrics`

## 运行保障

- 飞书文本发送遇到 `429`、`5xx`、常见网络抖动时会自动退避重试
- `serve` 收到 `SIGINT` / `SIGTERM` 时会优雅关闭 Webhook server 或飞书长连接
- 启动与停止都会写入审计日志，便于排障
- 可选管理端口支持 Prometheus 文本格式指标导出
- 提供 `examples/prometheus.yml` 与 `examples/alerts.yml` 作为监控落地模板

## 当前实现边界

已完成：

- 配置加载与全局/项目层合并
- 项目路由与会话持久化
- `codex exec` / `codex exec resume` 编排
- 飞书长连接接入
- 飞书 Webhook + 卡片回调接入
- CLI：`init` `serve` `doctor` `bind` `sessions` `codex install-skill`
- 启动预检、实例锁、优雅停机、发送重试
- 远端飞书诊断、Prometheus 指标导出

待继续增强：

- 更细粒度的流式进度卡片更新
- 更完整的飞书消息类型支持
- 告警接入示例与运行手册
