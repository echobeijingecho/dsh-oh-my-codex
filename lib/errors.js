// User-facing copy lives here, keyed by error code. Chinese is the primary
// language (single-user Chinese instances); the code is appended for operators.
// Dynamic details are appended by throw sites as `(detail)` segments.
const ERROR_TEXT = {
  ABORTED: ['Execution stopped.', '执行已停止。'],
  ENGINE_AUTH: ['Engine authentication failed. Sign in on the instance and retry in a new conversation.', '引擎认证失败。请在设置中重新登录 Codex 引擎，然后在新会话中重试。'],
  ENGINE_QUOTA: ['Engine quota or rate limit reached. No other engine was used.', '引擎额度或限流已达上限，未使用其他引擎。'],
  ENGINE_FAILED: ['Engine execution failed. The existing thread was preserved; no automatic retry was made.', '引擎执行失败。原有线程已保留，未自动重试。'],
  ENGINE_PROTOCOL: ['Codex sent a protocol-level error.', 'Codex 协议错误。'],
  ENGINE_START: ['Codex could not start. Check the configured executable.', 'Codex 未能启动，请检查配置的可执行文件。'],
  ENGINE_EXIT: ['Codex exited before completing its response.', 'Codex 在完成响应前退出了。'],
  ENGINE_PIPE: ['Codex connection closed.', '与 Codex 的连接已断开。'],
  ENGINE_TIMEOUT: ['Codex protocol request timed out.', 'Codex 协议请求超时。'],
  ENGINE_CLOSED: ['Codex connection closed.', '与 Codex 的连接已关闭。'],
  ENGINE_CONTEXT: ['The Codex thread exceeded its context window. Run /compact to compact it, or start a new conversation.', 'Codex 线程已超出上下文窗口。可运行 /compact 压缩线程后继续，或开启新会话。'],
  ENGINE_SANDBOX: ['The Codex sandbox could not run the command on this instance.', 'Codex 沙箱无法在此实例上运行该命令。'],
  ENGINE_POLICY: ['The request was blocked by the model provider policy.', '请求被模型服务策略拦截。'],
  ENGINE_UPSTREAM: ['The model service is unreachable or failing. The thread was preserved; retry shortly.', '模型服务不可达或出错。线程已保留，可稍后重试。'],
  ENGINE_THREAD: ['The engine did not return the expected durable thread.', '引擎未返回预期的持久线程标识。'],
  ENGINE_FORK: ['Codex could not fork the inherited thread. Start a new conversation.', 'Codex 无法分叉继承的线程，请开启新会话。'],
  ENGINE_SWITCH: ['This conversation is bound to its execution engine. Start a new conversation to switch engines.', '本会话已绑定执行引擎，切换引擎请开启新会话。'],
  ENGINE_DISABLED: ['The selected engine is not enabled.', '所选引擎未启用。'],
  ENGINE_RECOVERY: ['The previous engine operation has an uncertain outcome. Inspect it before starting a new conversation; it will not be repeated automatically.', '上一轮引擎操作结果不确定，请先核查再开始新对话；系统不会自动重复该操作。'],
  ENGINE_STATE: ['The engine binding state is invalid; the operation was not executed.', '会话引擎绑定状态异常，操作未执行。'],
  ENGINE_INPUT: ['The message does not satisfy the engine input requirements.', '输入不满足引擎要求。'],
  ENGINE_ATTACHMENT: ['This engine route currently accepts text and DSH file-path references, not inline images.', '该引擎链路暂不接受内联图片，请使用文字或 DSH 文件路径引用。'],
  ENGINE_OUTPUT: ['Engine output exceeded the configured limit. Execution was stopped.', '引擎输出超出配置上限，执行已被停止。'],
  ENGINE_BUSY: ['This conversation already has an active engine request.', '本会话已有正在执行的引擎请求，请稍候。'],
  ENGINE_WORKSPACE: ['The session workspace is not usable for external engines.', '会话工作区不满足外部引擎要求。'],
  ENGINE_PERMISSION: ['External engines require read-only or workspace-write permissions. Full-access and auto-review modes are not supported.', '外部引擎仅支持只读或工作区写权限，不支持完全权限与自动审查模式。'],
  ENGINE_MODEL: ['This model is not enabled for the selected engine.', '该模型未对所选引擎启用。'],
  ENGINE_MULTI_AGENT_UNAVAILABLE: ['Native Codex multi-agent is unavailable for this model or instance.', '当前模型或实例不支持 Codex 原生多 Agent。'],
  ENGINE_AUXILIARY: ['Configure an ordinary DSH model for titles and compaction; these requests never launch a coding engine.', '请为标题与压缩配置一个普通 DSH 模型；这些请求不会启动编码引擎。'],
  ENGINE_SESSION: ['The request does not belong to the active DSH session.', '请求不属于当前活跃的 DSH 会话。'],
  ENGINE_IMAGE_READ: ['The image attachment could not be read (it may have been cleaned up). Upload it again.', '图片附件读取失败（可能已被清理）。请重新上传后再发送。'],
  ENGINE_IMAGE_TYPE: ['The encoded image type is unsupported (PNG, JPEG, WebP, GIF only).', '图片格式不受支持（仅支持 PNG、JPEG、WebP、GIF）。'],
  ENGINE_IMAGE_SIZE: ['The image exceeds the 25 MiB Codex input limit. Compress it and retry.', '图片超过 25 MiB 的 Codex 输入上限，请压缩后重试。'],
  ENGINE_IMAGE_STORE: ['The image could not be staged on this instance (disk permission or space).', '无法在本实例暂存图片（磁盘权限或空间问题）。请反馈给实例管理员。'],
  ENGINE_IMAGE_COUNT: ['Too many images in one turn. Send them across several messages.', '本轮图片数量超过上限，请减少图片后分多轮发送。'],
}

export function errorText(code) {
  return ERROR_TEXT[code]?.[1] || code
}

export class EngineError extends Error {
  constructor(code, detail) {
    // The code rides along in the message for operators; detail is a short
    // technical fragment (method name, protocol reason) worth surfacing.
    super(`${errorText(code)}${detail ? `（${detail}）` : ''} [${code}]`)
    this.name = 'EngineError'
    this.code = code
  }
}

// Never echo an SDK error verbatim: proxy URLs and credentials can appear in it.
export function engineFailure(error) {
  if (error instanceof EngineError) return { code: error.code, message: error.message }
  if (error?.name === 'AbortError') return { code: 'ABORTED', message: errorText('ABORTED') }
  const text = String(error?.message ?? error)
  if (/401|unauthorized|authentication|login|credential|api.?key/i.test(text)) {
    return { code: 'ENGINE_AUTH', message: errorText('ENGINE_AUTH') + ' [ENGINE_AUTH]' }
  }
  if (/429|rate.?limit|quota|credit/i.test(text)) {
    return { code: 'ENGINE_QUOTA', message: errorText('ENGINE_QUOTA') + ' [ENGINE_QUOTA]' }
  }
  return { code: 'ENGINE_FAILED', message: errorText('ENGINE_FAILED') + ' [ENGINE_FAILED]' }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Execution stopped.', 'AbortError')
}
