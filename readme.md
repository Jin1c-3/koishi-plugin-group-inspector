# koishi-plugin-group-inspector

[![npm](https://img.shields.io/npm/v/koishi-plugin-group-inspector?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-group-inspector)

入群申请智能审核插件：支持“全局正则拒绝 + 频率/多群检测 + 自动通过规则 + 手动审批”全流程。

## ✨ 特性

- 全局拒绝条件：配置一组正则表达式，验证信息命中任意一条即自动拒绝（用于过滤广告、骚扰模板）。
- 重复 / 多群检测：短时间内多次申请或已在其他受管群时可直接拒绝。
- 自动通过规则：按群配置关键词 (正则) + 最低 QQ 等级 (可选)，符合即自动通过。
- 手动审批：未命中拒绝也不满足自动通过时，转发到指定群或私聊等待人工指令处理。
- 批量操作：支持“ya/na/全部同意/全部拒绝”一键处理积压请求。
- 超时策略：人工未处理时自动执行“通过”或“拒绝”。
- 可选调试日志：便于观察匹配与触发过程。

## ⚙️ 核心配置概览

| 配置项                                    | 说明                                                       |
| ----------------------------------------- | ---------------------------------------------------------- |
| `groups`                                  | 需要进行重复成员检测的已管理群列表                         |
| `interval`                                | 缓存时间窗口 (分钟)，用于频率检测                          |
| `uniqueEnable` / `uniqueDenyThreshold`    | 是否启用多群/频率检测与最大拒绝次数                        |
| `globalDenyEnable` / `globalDenyPatterns` | 全局拒绝正则开关与正则数组，命中即拒绝                     |
| `MemberRequestAutoRules[]`                | 自动通过规则：`guildId` + 可选 `keyword` + 可选 `minLevel` |
| `enableManualApproval` / `notifyTarget`   | 手动审批开关与通知目标 (guild:123 / private:456)           |
| `manualTimeout` / `manualTimeoutAction`   | 超时分钟数与超时默认操作 (accept/reject)                   |
| `enableDebug`                             | 调试日志开关                                               |

### 全局拒绝正则示例

```yaml
globalDenyPatterns:
	- '(?i)管理员你好.*交流学习'
	- '(?i)通过一下'
	- '(?i)管理员你好'
```

说明：

- 使用标准 JS 正则语法，不需要包裹斜杠 `/.../`。
- 可以使用分组、前瞻、忽略大小写等高级特性。
- 建议从宽到紧，避免过度误杀。

### 自动通过规则示例

```yaml
MemberRequestAutoRules:
	- guildId: '123456789'
		keyword: '交流|学习|技术'
		minLevel: 10
```

以上示例表示：在群 `123456789` 中，验证信息包含“交流/学习/技术”任意一个且 QQ 等级 ≥ 10 时自动通过。

### 手动审批指令

在通知目标里回复：

| 指令                    | 作用                   |
| ----------------------- | ---------------------- |
| `y<编号>`               | 通过指定请求           |
| `n<编号> [理由]`        | 拒绝指定请求并附理由   |
| `ya [备注]`             | 批量通过所有待处理请求 |
| `na [理由]`             | 批量拒绝所有待处理请求 |
| `全部同意` / `全部拒绝` | 同上中文指令           |

### 超时处理

未在 `manualTimeout` 分钟内处理的请求自动按 `manualTimeoutAction` 执行，并发送结果通知。

## 🛠 使用提示

- 建议先只启用手动审批，观察真实验证信息，再逐步添加正则。
- 正则请尽量避免过于宽泛，如 `.*` 或极易误杀的单字。
- 若出现误杀，可在正则前加否定条件或拆分更精细的模式。

## 📄 License

MIT
