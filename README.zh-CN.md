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


## 许可证

MIT。
