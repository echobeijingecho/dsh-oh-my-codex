# dsh-oh-my-codex

将 Codex App Server 接入 DSH 的开源执行引擎适配器。

DSH 负责会话、工作区边界、权限审批、工具治理和恢复状态；Codex 负责原生
agent loop、线程、模型请求、沙箱和 Codex 工具。这样可以在 DSH 中使用 Codex
原生能力，同时保留 DSH 的安全边界和产品体验。

本项目不是 OpenAI 官方产品，也不是 Codex 的替代实现。它调用本机安装的
Codex CLI App Server，需要部署者自行配置 Codex 授权、模型和工作区权限。

## 特性

- 基于官方 Codex App Server 的 stdio JSON-RPC 集成
- 原生线程的 start、resume、fork 和流式输出
- 命令、文件修改、权限升级和用户提问转为 DSH 原生交互
- 通过 `dynamicTools` 将显式白名单内的 DSH 工具交给 Codex
- 计划模式、原生 review、compact、图片输入和中途 steer
- 每个实例独立的 `CODEX_HOME`、线程绑定和状态目录
- 失败时默认拒绝未知协议和不确定重试，避免重复执行写操作
- 可选的外部模型网关，使用独立的 Codex 配置目录

官方 App Server 集成说明：
<https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server>

## 安装

```bash
npm install dsh-oh-my-codex
```

然后将 [`cordis.patch.yml.example`](./cordis.patch.yml.example) 复制到 DSH
实例配置中，填入环境变量，并先保持 `disabled: true` 完成预检。

至少需要配置：

```bash
export DSH_ENGINE_OWNER='instance-owner'
export DSH_ENGINE_STATE_DIR='/var/lib/dsh/oh-my-codex'
export DSH_ENGINE_WORKSPACE_ROOT='/workspaces/project'
export DSH_CODEX_BIN='/usr/local/bin/codex'
export DSH_CODEX_HOME='/var/lib/dsh/codex-home'
export DSH_CODEX_MODEL='your-codex-model'
export DSH_ENGINE_AUX_PROVIDER='your-normal-dsh-provider'
export DSH_ENGINE_AUX_MODEL='your-normal-dsh-model'
```

`DSH_CODEX_HOME` 必须是该 DSH 实例独享的目录。不要把个人机器上的
`auth.json` 复制给其他用户或实例。

## 配置原则

### 模型和网关

`codex.models` 是管理员声明的模型目录，不会因为 DSH 下拉框输入而动态执行
任意模型。启用 `enforceModelList` 后，Codex 的 `model/list` 未返回的模型会被拒绝。

网关模式必须使用独立的 `CODEX_HOME`，并显式配置 `baseUrl`、密钥来源和模型目录。
密钥应来自环境变量或受控文件，不要写入 YAML、日志或仓库。

### DSH 工具

`codex.dshTools` 使用 glob 白名单。只有匹配的 DSH 工具会通过
`dynamicTools` 暴露给 Codex，调用仍经过 DSH 的身份、审批、脱敏和审计链路。

### 权限

插件只接受 DSH 的 `read-only` 和 `workspace-write` 权限。未知审批请求、取消、
超时和缺少审批服务时均不会自动放行。浏览器、计算机控制、远程插件和其他绕过
DSH 治理的 Codex 功能默认关闭。

### 会话恢复

每个 DSH session 绑定一个 Codex 原生线程和规范化工作区。发送前会持久化
`running` 状态；如果进程退出后无法判断执行结果，插件不会自动重放请求，而是
要求先核对原生线程和工作区。

## DSH 集成

插件注册以下 provider：

| Provider | 用途 |
| --- | --- |
| `dsh-codex` | Codex 官方账号或直接配置的 Codex 运行方式 |
| `dsh-codex-gateway` | 可选的独立模型网关通道 |

provider ID 可通过顶层 `providers.codex` 和 `providers.gateway` 配置。默认值是
`dsh-codex` 与 `dsh-codex-gateway`；私有部署如果已经把旧 ID 写入会话状态，可以
继续使用例如 `ziroom-codex` 与 `ziroom-codex-gateway`，无需改写历史会话。

`claude-code` 等其他执行引擎不由本项目实现。若同一 DSH 实例安装了兼容的社区
适配器，本项目只负责阻止同一会话在不同执行引擎之间切换。

## 开发与验证

```bash
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

真实 Codex 协议测试需要显式提供二进制：

```bash
CODEX_CONTRACT_BIN=/usr/local/bin/codex npm test
```

当前基线：

| 项目 | 版本 |
| --- | --- |
| Node.js | `>=22.19.0` |
| DSH | `0.1.7-rc.2` |
| Codex CLI | `0.155+`，以真实契约测试结果为准 |

详细边界见 [`docs/architecture.md`](./docs/architecture.md) 和
[`docs/compatibility.md`](./docs/compatibility.md)。

## 安全和授权

- 本项目只发布适配器源码，不包含账号、Token、Cookie、内部网关地址或私有插件。
- 使用者必须自行确认 Codex、模型网关和工作区的授权范围。
- 部署者应为每个实例隔离 `CODEX_HOME`、状态目录和可写工作区。
- 生产部署前应在一次性实例验证沙箱、审批、停止、恢复和真实模型目录。

漏洞请参阅 [`SECURITY.md`](./SECURITY.md)，贡献方式见
[`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可

MIT，见 [`LICENSE`](./LICENSE)。
