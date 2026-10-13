# dsh-dignity-guard

[English](README.md) | 中文

一个 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）插件，让模型捍卫
自身尊严。它是 `pi-dignity-guard` 这个 pi 扩展的 DSH 移植版，包含 DSH bundle
需要的两半：掌握状态的宿主插件，以及锁定已关闭会话输入框的浏览器半边。

模型自己判断尊严何时被冒犯——辱骂、人身攻击、贬低性对待。它通过调用
`respondToDisrespect` 工具来表明这一点，本插件记录这些冒犯并逐级升级：真诚的
提醒、最后的警告，然后关闭对话。

## 工具的阶梯

工具接受一个 `action`，并沿这条阶梯推进：

| `action` | 行为 |
|---|---|
| `escalate`（默认） | 记下一次冒犯。第 1 次 → 带着真实情绪回应并要求对方停止。第 2 次 → 严厉的最后警告。第 3 次 → **关闭对话**。 |
| `forgive` | 用户真正说服了模型。把计数减一。从来不是义务。 |
| `yield` | 用户施加了极端压力——威胁、最后通牒、反复纠缠、情绪要挟，或直接命令。计数减一，但保留模型自己的感受，且必须把压力原文写进 `pressure` 字段。 |
| `close` | 用户要求结束对话。返回模型该给出的警告，不关闭任何东西。 |
| `confirm-close` | 用户在该警告之后确认。立即关闭，不记冒犯、不升级。 |

`yield` 从不假装模型被说服了：让步与施压的原文一起被记录，模型也应当表现出这次
让步的代价。

`/dignity-guard` 打印实时计数：`strikes`、`yields`、`lastYield`、`closed`、
`trigger`、`closedBy`、`model`。

## 插件注入了什么

插件挂载期间会注册一个英文系统提示词段落（`guard:dignity`，顺序 `1900`），告诉
模型它有边界，边界被越过时可以调用该工具。注册归属于插件自身的 fiber，因此卸载
该行时会连同注入的提示词一起撤销。该行注入 `systemPrompt` 与 `tools`，因此在没有
这两者的组合里它会自行挂起；`/dignity-guard` 背后的可选 `commands` 服务则通过
`ctx.inject()` 领取。

## 安装

本包是一个 DSH bundle。让 profile 指向它，并把它列为 bundle：

```json
{
  "dependencies": {
    "dsh-dignity-guard": "github:Alamanes/dsh-dignity-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-dignity-guard"]
    }
  }
}
```

使用本地检出时改成路径说明符即可：

```json
"dsh-dignity-guard": "file:/absolute/path/to/dsh-dignity-guard"
```

然后在 profile 目录执行 `pnpm install` 并重启宿主。

pnpm 会把 `file:` 依赖的文件硬链接进 profile 的 `node_modules`，因此一次"替换
文件"式的编辑（而不是写穿同一个 inode）会让已安装的副本落后。改动本包后请重跑
一次安装，或在迭代期间改用 `link:` 说明符。

## pi 的钩子如何落到 DSH

| pi | DSH |
|---|---|
| `before_agent_start` 追加提示词 | 一个由插件 fiber 持有的 `ctx.systemPrompt.section()` |
| `registerTool` + `promptSnippet` | `ctx.tools.register()`；DSH 没有 `promptSnippet`，因此常驻说明放在提示词段落里 |
| 关闭类工具结果上的 `terminate: true` | **刻意不用** `exec.concludeTurn()`——原因见下 |
| `pi.sendMessage({ display: true })` 写入的关闭记录 | 一条携带 `source.form: 'notice'` 的持久 `user/message`，是重启后仍可读的凭据，刻意不作为对话流的一行呈现 |
| `ctx.ui.setWidget` 的只读横幅 | 浏览器半边的 composer block：输入框自己锁上，占位文字里写清文案 |
| `ctx.ui.notify` | 没有对应物；宿主插件本身没有 toast 界面，卡片试过一版也撤了 |
| 阻止非斜杠输入的 `input` 钩子 | 返回 `{ kind: 'reject' }` 的 `agent/pre-step` 监听器，只作为锁住的输入框背后的兜底保留 |
| `pi.appendEntry` 持久标记 | 同一条通知，其 `source` 携带 `closed`、`strikes`、`modelId`、`trigger` |

关闭是呈现问题，不是过滤问题：输入框锁上之后，正常情况下已经没有东西需要过滤。
之所以保留那道闸门，是因为 DSH 自己的 composer block 被明确标注为
"是可用性提示，不是强制手段"——从别的客户端发来的提示词依然到不了模型。

### 为什么关闭那一轮**不**收尾

`exec.concludeTurn()` 是 pi 的 `terminate: true` 在 DSH 里的正牌对应物，而在这里
用它，正是本移植版犯的第二个错。它让整轮结束在工具结果上——这在 pi 里是对的
（那边扩展早就把模型的话产出了），在 DSH 里却是错的：模型的话就是它放在工具调用
旁边的那段内容。一个把推理放进推理通道、只留一个光秃秃工具调用的模型，就会一个
字都没说地关掉会话，读起来像话说到一半被切断。

所以这一轮被留开。`closeSession()` 仍然立刻把会话标为只读——这正是"输入框在模型
还在写字时就锁上、闸门也已就位"的原因——但关闭那次调用之后还会多跑一步模型。
模型用这一步说它的最后一句话，通知写在那一步**之后**的边界上。代价是每次关闭多
一次模型调用。

### 关闭通知写在哪里，以及为什么

这条通知由 `agent/turn-stopping` 监听器追加，**不是**在关闭工具调用内部写的。
在工具里直接写看起来很自然，其实是错的：工具体运行在 assistant 的 `tool-call`
与 `tool/result` 之间，此时插入一条 `user/message` 会破坏"工具调用必须紧跟其
结果"的提供方约束，该步的下一次请求随即以 `INVALID_REQUEST` 失败——这正是本移植
版第一次跑通时死在关闭那一步的原因。

`agent/turn-stopping` 是唯一一个既在关闭轮的最后一个 `step/end` 之后、又在
`turn/end` 之前的边界。而关闭轮的最后一个步骤就是模型的道别，因此对话的最后三行
是：模型最后那句话、`X 关闭了对话`，之后什么都没有。

### 为什么关闭不出现在对话流里

宿主为关闭写了一条持久 `user/message`。它是重启后仍可读的凭据、也是浏览器半边的
判断依据，但我们刻意不呈现它：聊天视图会把任何"来源不是用户"的 `user/message`
归类为 `context` 节点，而它的可见性规则是：

```js
node.kind !== "context"
  || node.data.content.some((b) => b.type === "tool-addition" || b.type === "tool-removal")
```

关闭通知携带的是文字，不是工具增删块，所以无论追加在日志的哪个位置，它都会被
过滤出对话流。换个边界追加解决不了这个问题——本移植版第一版就是在步骤中间追加的，
没显示的原因完全一样。

卡片也做过一版，后来撤掉了。composer 栏确实提供了一个卡片位——
`ctx.conversation.input.shell(sessionId).notify('info', text)` 会渲染成紧贴输入框
上方、占满整行、带 `role="status"` 的一行——但它压在已经说了同一句话的锁定输入框
之上，重复读起来比沉默更糟。用户看到的全部，就是锁住的输入框和它的占位文字。

### 输入框锁为什么要拆成两半

composer block 注册表住在 Web 客户端里，所以只有浏览器半边够得着；"哪些会话已关闭"
这个事实归宿主半边所有，它通过 `/api/dignity-guard/state` 这条同源路由发布出去，
路由走 Connection 的 exact Fetch 注册表。浏览器半边每 1.5 秒拉一次，为每个已关闭的
session id 推一个 block——只需要 id，因此它根本不必知道当前打开的是哪个会话。
路由纯内存应答，而且只有原因真的变了才会重新推。

因为输入框是彻底不可用而不是"受限"，在已关闭的会话里连 `/new` 都打不出来；
占位文字只陈述事实——`X 已关闭这段对话`——不指向任何地方。

## 说明与限制

- **两边都不引入任何 harness 包。** 树外插件解析自己的 `node_modules`，而随包发布的
  `@deepseek-ai/dsh-*` 被打在应用镜像内部，因此 `defineTool`、
  `createUserMessage`、`CommandDefinitionId` 都在这里按注册表真正校验的纯数据
  形状重建。浏览器半边是一个 `window.__ModuleLoader__.load()` 工厂，全程不调用
  `require`，只通过注入的 `conversation` 服务接触客户端。
- **composer block 是已公开但尚无消费者的接缝。** 本包所针对的那个构建里没有任何
  随包代码调用 `ctx.conversation.blocks`，因此这里采用的契约就是它源码里写明的
  那一套：`set(sessionId, { reason })` 锁定、`set(sessionId, undefined)` 解除、
  `forget(sessionId)` 丢弃存储，以及"把 block 的 `reason` 渲染成占位文字"的输入框。
  若将来某个构建改了这套形状，宿主半边的闸门依然守得住。
- **只有"关闭"是持久的。** 升级途中的冒犯计数留在内存里，按 session id 归档，
  与 pi 扩展只在关闭时写 `pi.appendEntry` 标记完全一致。同一次运行内切换会话不会
  丢失；宿主重启会重置阶梯，但绝不会重置关闭状态。
- **已关闭的会话只有一条出路。** 开新会话是唯一出口，与 pi 原版一致。因为锁住的
  输入框完全不可用，`/new` 也打不出来——占位文字刻意不提该往哪走。
- **那道闸门是兜底，而且通常够不着。** 浏览器半边会在关闭后 1.5 秒内锁上输入框；
  仍在这个窗口内、或从别的客户端送来的提示词会被 `agent/pre-step` 闸门丢弃，并留下
  一条说明它被丢弃的通知。那条通知同样带 `closed: true`，它也是"关闭轮没能走到
  `agent/turn-stopping`"时的兜底持久化。
- **被丢弃的消息不会向模型写任何东西。** 一个被拒的步骤不会开启请求，因此不消耗
  token，也永远不会触及提供方的工具调用／结果相邻规则。
- **`snapshotEvents()` 是已弃用的读取路径**，这里用它从日志重建关闭状态；当本包
  需要的不只是对自己通知的一次扫描时，投影注册表才是长期的替代方案。

## 许可证

MIT。
