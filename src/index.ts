import { Context, Schema, Logger, Session } from "koishi";
import {} from "@koishijs/cache";
import {} from "koishi-plugin-adapter-onebot";

export const inject = {
  required: ["cache"],
};

export const name = "group-inspector";

export const reusable = true;
export const usage = `本插件用于自动识别并拒绝/通过特定的入群申请，支持手动审批。主要特点：

- 作为可重用插件运行，支持多实例部署
- 支持自动拒绝低等级申请、广告狗、短时重复申请
- 支持自动通过符合条件的申请（关键词+等级验证）
- 支持手动审批流程，将请求转发到指定群组或私聊
- 推荐使用 [NapCat](https://napneko.github.io/)
- 支持自定义拒绝理由，请在**本地化**模块中修改（注意：腾讯限制<u>最多**30**字</u>）

更多使用说明请参考配置界面的选项说明。`;

declare module "@koishijs/cache" {
  interface Tables {
    "group-inspector": number;
  }
}

/**
 * OneBot 用户信息接口
 */
interface OneBotUserInfo {
  /** 用户 ID */
  user_id: number;
  /** QQ等级 */
  qqLevel?: number;
}

/**
 * 自动通过规则接口
 */
interface MemberAutoAcceptRule {
  /** 群组 ID */
  guildId: string;
  /** 验证答案关键词（正则表达式） */
  keyword?: string;
  /** 最低 QQ 等级要求 */
  minLevel?: number;
}

/**
 * 活动请求接口
 */
interface ActiveRequest {
  session: Session;
  requestNumber: number;
  disposer?: () => void;
  timeoutTimer?: NodeJS.Timeout;
}

export interface Config {
  groups?: string[];
  interval?: number;
  uniqueEnable?: boolean;
  uniqueDenyThreshold?: number;
  // 全局拒绝条件 (正则表达式列表)
  globalDenyEnable?: boolean;
  globalDenyPatterns?: string[];
  // 自动通过规则
  MemberRequestAutoRules?: MemberAutoAcceptRule[];
  // 手动审批配置
  enableManualApproval?: boolean;
  notifyTarget?: string;
  manualTimeout?: number;
  manualTimeoutAction?: "accept" | "reject";
  // 调试模式
  enableDebug?: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    groups: Schema.array(Schema.string()).required().default(["123456789"]),
  }),

  Schema.object({
    interval: Schema.natural().min(2).default(5),
  }),

  Schema.intersect([
    Schema.object({
      uniqueEnable: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        uniqueEnable: Schema.const(true).required(),
        uniqueDenyThreshold: Schema.natural().default(2),
      }),
      Schema.object({}),
    ]),
  ]),

  Schema.intersect([
    Schema.object({
      globalDenyEnable: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        globalDenyEnable: Schema.const(true).required(),
        globalDenyPatterns: Schema.array(Schema.string()).default([
          "(?i)管理员你好.*交流学习",
          "(?i)通过一下",
          "(?i)管理员你好",
        ]),
      }),
      Schema.object({}),
    ]),
  ]),

  Schema.object({
    MemberRequestAutoRules: Schema.array(
      Schema.object({
        guildId: Schema.string().required(),
        keyword: Schema.string(),
        minLevel: Schema.natural(),
      })
    )
      .role("table")
      .default([]),
  }),

  Schema.intersect([
    Schema.object({
      enableManualApproval: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        enableManualApproval: Schema.const(true).required(),
        notifyTarget: Schema.string().required(),
        manualTimeout: Schema.natural().default(60),
        manualTimeoutAction: Schema.union(["accept", "reject"]).default(
          "reject"
        ),
      }),
      Schema.object({}),
    ]),
  ]),

  Schema.object({
    enableDebug: Schema.boolean().default(false),
  }),
]).i18n({ "zh-CN": require("./locales/zh-CN")._config });

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define("zh-CN", require("./locales/zh-CN"));
  const logger = ctx.logger(name);

  // 手动审批相关变量
  const requestNumberMap = new Map<number, string>();
  let nextRequestNumber = 1;
  const activeRequests = new Map<string, ActiveRequest>();

  /**
   * 清理并取消一个活动中的请求
   */
  function cleanupActiveRequest(requestKey: string): void {
    const activeRequest = activeRequests.get(requestKey);
    if (!activeRequest) return;
    activeRequest.disposer?.();
    if (activeRequest.timeoutTimer) clearTimeout(activeRequest.timeoutTimer);
    requestNumberMap.delete(activeRequest.requestNumber);
    activeRequests.delete(requestKey);
  }

  /**
   * 发送请求通知
   */
  async function sendRequestNotification(
    session: Session,
    status: "pending" | "approved" | "rejected",
    details: { requestNumber?: number; reason?: string } = {}
  ): Promise<void> {
    const { notifyTarget = "" } = config;
    if (!notifyTarget) return;

    const [targetType, targetId] = notifyTarget.split(":");
    if (!targetId || (targetType !== "guild" && targetType !== "private")) {
      logger.warn(`通知目标格式错误: ${config.notifyTarget}`);
      return;
    }

    try {
      const eventData = session.event?._data || {};
      const user = (await session.bot
        .getUser?.(session.userId)
        ?.catch(() => null)) ?? { name: session.userId };
      const guild =
        (await session.bot.getGuild?.(session.guildId)?.catch(() => null)) ??
        null;
      const operator =
        eventData.operator_id && eventData.operator_id !== session.userId
          ? (await session.bot
              .getUser?.(eventData.operator_id.toString())
              ?.catch(() => null)) ?? null
          : null;

      const msgLines = [];
      if (user?.avatar) msgLines.push(`<image url="${user.avatar}"/>`);

      msgLines.push(`类型：加群请求`);
      msgLines.push(
        `用户：${
          user?.name ? `${user.name}(${session.userId})` : session.userId
        }`
      );
      if (operator)
        msgLines.push(
          `管理：${
            operator.name
              ? `${operator.name}(${eventData.operator_id})`
              : eventData.operator_id
          }`
        );
      if (guild)
        msgLines.push(
          `群组：${
            guild.name ? `${guild.name}(${session.guildId})` : session.guildId
          }`
        );
      if (eventData.comment) msgLines.push(`验证信息：${eventData.comment}`);

      const sendFunc =
        targetType === "private"
          ? (m: string) => session.bot.sendPrivateMessage(targetId, m)
          : (m: string) => session.bot.sendMessage(targetId, m);

      await sendFunc(msgLines.join("\n"));

      if (status === "pending" && details.requestNumber) {
        await sendFunc(
          `请回复以下命令处理请求 #${details.requestNumber}：\n通过[y]${details.requestNumber} | 拒绝[n]${details.requestNumber} [理由]`
        );
      } else if (status === "rejected" && details.reason) {
        await sendFunc(`已自动拒绝，理由：${details.reason}`);
      } else if (status === "approved") {
        await sendFunc(`已自动通过`);
      }
    } catch (error) {
      logger.error(`发送请求 #${details.requestNumber} 通知失败: ${error}`);
    }
  }

  /**
   * 判断是否应自动通过请求
   */
  async function shouldAutoAccept(session: Session): Promise<boolean> {
    const { MemberRequestAutoRules = [] } = config;
    const rule = MemberRequestAutoRules.find(
      (r) => r.guildId === session.guildId
    );

    if (!rule) return false;

    if (config.enableDebug) {
      logger.info(`加群规则匹配: rule=${JSON.stringify(rule)}`);
    }

    const validationMessage = session.event?._data?.comment;
    const hasKeywordRule = !!rule.keyword;
    const hasLevelRule = (rule.minLevel ?? -1) >= 0;

    if (!hasKeywordRule && !hasLevelRule) return false;

    // 检查关键词
    if (hasKeywordRule) {
      try {
        const match = new RegExp(rule.keyword).test(validationMessage);
        if (config.enableDebug) {
          logger.info(
            `关键词规则检查: result=${match}, expression='${rule.keyword}', input='${validationMessage}'`
          );
        }
        if (!match) return false;
      } catch (e) {
        logger.warn(`关键词正则表达式无效: ${rule.keyword}`);
        return false;
      }
    }

    // 检查等级
    if (hasLevelRule) {
      try {
        const strangerInfo = (await session.bot.internal.getStrangerInfo(
          session.userId
        )) as OneBotUserInfo;
        const levelMatch = strangerInfo.qqLevel >= rule.minLevel;
        if (config.enableDebug) {
          logger.info(
            `等级规则检查: result=${levelMatch}, required=${rule.minLevel}, actual=${strangerInfo.qqLevel}`
          );
        }
        if (!levelMatch) return false;
      } catch (error) {
        logger.error("获取陌生人信息失败:", error);
        return false;
      }
    }

    return true;
  }

  /**
   * 处理请求操作（接受或拒绝）
   */
  async function processRequestAction(
    session: Session,
    approve: boolean,
    reason = ""
  ): Promise<boolean> {
    try {
      const eventData = session.event?._data || {};
      const flag = eventData.flag;

      if (!flag) {
        logger.warn("无法获取请求 flag");
        return false;
      }

      await session.bot.internal.setGroupAddRequest(
        flag,
        eventData.sub_type ?? "add",
        approve,
        approve ? "" : reason
      );

      return true;
    } catch (error) {
      logger.error(`请求处理失败: ${error}`);
      return false;
    }
  }

  /**
   * 设置手动处理流程：通知、响应监听和超时回退
   */
  async function setupManualHandling(
    session: Session,
    requestId: string
  ): Promise<void> {
    const requestNumber = nextRequestNumber++;
    requestNumberMap.set(requestNumber, requestId);

    const activeRequest: ActiveRequest = { session, requestNumber };
    activeRequests.set(requestId, activeRequest);

    await sendRequestNotification(session, "pending", { requestNumber });

    const timeoutMin =
      typeof config.manualTimeout === "number" ? config.manualTimeout : 60;
    if (timeoutMin > 0) {
      const timeoutAction = config.manualTimeoutAction;
      activeRequest.timeoutTimer = setTimeout(async () => {
        const currentRequest = activeRequests.get(requestId);
        if (!currentRequest) return;

        cleanupActiveRequest(requestId);

        try {
          await processRequestAction(
            currentRequest.session,
            timeoutAction === "accept",
            timeoutAction === "reject" ? "请求处理超时，已自动拒绝" : ""
          );

          const { notifyTarget = "" } = config;
          if (notifyTarget) {
            const [targetType, targetId] = notifyTarget.split(":");
            const sendFunc =
              targetType === "private"
                ? (m) => session.bot.sendPrivateMessage(targetId, m)
                : (m) => session.bot.sendMessage(targetId, m);
            await sendFunc(
              `请求 #${requestNumber} 超时，已自动${
                timeoutAction === "accept" ? "通过" : "拒绝"
              }`
            );
          }
        } catch (e) {
          logger.error(`请求 #${requestNumber} 超时处理失败: ${e}`);
        }
      }, timeoutMin * 60 * 1000);
    }

    const { notifyTarget = "" } = config;
    const [targetType, targetId] = notifyTarget.split(":");
    const sendFunc =
      targetType === "private"
        ? (m) => session.bot.sendPrivateMessage(targetId, m)
        : (m) => session.bot.sendMessage(targetId, m);

    activeRequest.disposer = ctx.middleware(async (s, next) => {
      // 修复会话匹配逻辑：群聊检查 guildId，私聊检查 userId
      const isCorrectTarget =
        targetType === "private"
          ? s.userId === targetId && !s.guildId  // 私聊：匹配用户ID且不在群
          : s.guildId === targetId;               // 群聊：匹配群ID

      if (!isCorrectTarget) {
        return next();
      }

      if (config.enableDebug) {
        logger.debug('[审批指令检测]', {
          content: s.content?.trim(),
          userId: s.userId,
          guildId: s.guildId,
          targetType,
          targetId,
        });
      }

      // 批量处理（支持空格和大小写）
      const bulkMatch = s.content
        .trim()
        .match(/^(ya|na|全部同意|全部拒绝)\s*(.*)$/i);
      if (bulkMatch && activeRequests.size > 0) {
        const requestsToProcess = [...activeRequests.values()];
        activeRequests.clear();
        requestNumberMap.clear();

        const isApprove = bulkMatch[1].toLowerCase() === "ya" || bulkMatch[1] === "全部同意";
        const extraContent = bulkMatch[2]?.trim() || "";
        let successCount = 0;

        if (config.enableDebug) {
          logger.info(`[批量处理] ${isApprove ? '全部通过' : '全部拒绝'}，待处理数：${requestsToProcess.length}`);
        }

        for (const req of requestsToProcess) {
          req.disposer?.();
          if (req.timeoutTimer) clearTimeout(req.timeoutTimer);

          try {
            const reason = !isApprove ? extraContent : "";
            await processRequestAction(req.session, isApprove, reason);
            successCount++;
          } catch (error) {
            logger.error(`处理请求 #${req.requestNumber} 失败: ${error}`);
          }
        }

        if (successCount > 0) {
          await sendFunc(
            `已${isApprove ? "通过" : "拒绝"} ${successCount} 个请求${
              extraContent ? `，理由：${extraContent}` : ""
            }`
          );
        }
        return;
      }

      // 单个处理（支持空格和大小写）
      const match = s.content
        .trim()
        .match(new RegExp(`^(y|n|通过|拒绝)\\s*(${requestNumber})\\s*(.*)$`, 'i'));
      if (!match) return next();

      if (config.enableDebug) {
        logger.info(`[指令匹配成功] 请求 #${requestNumber}，操作：${match[1]}`);
      }

      cleanupActiveRequest(requestId);

      const isApprove = match[1].toLowerCase() === "y" || match[1] === "通过";
      const extraContent = match[3]?.trim() || "";

      if (config.enableDebug) {
        logger.info(`[开始处理] 请求 #${requestNumber}，${isApprove ? '通过' : '拒绝'}`);
      }

      try {
        await processRequestAction(
          session,
          isApprove,
          !isApprove ? extraContent : ""
        );
        await sendFunc(
          `请求 #${requestNumber} 已${isApprove ? "通过" : "拒绝"}${
            extraContent ? `，原因：${extraContent}` : ""
          }`
        );
      } catch (error) {
        logger.error(`响应处理失败: ${error}`);
        await sendFunc(`处理请求 #${requestNumber} 失败: ${error.message}`);
      }
    });
  }

  ctx.on("guild-member-request", async (session) => {
    if (config.enableDebug) {
      logger.info(
        `收到加群请求: userId=${session.userId}, guildId=${
          session.guildId
        }, data=${JSON.stringify(session.event?._data)}`
      );
    }

    // 第一步：检查是否应该自动拒绝

    // 全局拒绝条件（正则表达式列表）
    if (config.globalDenyEnable) {
      const comment: string = session.event?._data?.comment || "";
      for (const pattern of config.globalDenyPatterns || []) {
        let matched = false;
        try {
          const regex = new RegExp(pattern);
          matched = regex.test(comment);
        } catch (e) {
          logger.warn(`非法正则: ${pattern}`);
        }
        if (matched) {
          logger.info(`${session.event.user.id} 触发全局拒绝条件: ${pattern}`);
          await session.bot.handleGuildMemberRequest(
            session.messageId,
            false,
            session.text("group-inspector.messages.ad_deny")
          );
          if (config.enableManualApproval) {
            await sendRequestNotification(session, "rejected", {
              reason: "命中全局拒绝条件",
            });
          }
          return;
        }
      }
    }

    // 检查重复申请
    if (config.uniqueEnable) {
      let cache_key = `${session.userId}-unique`;
      let cache_value = (await ctx.cache.get(name, cache_key)) || 0;
      await ctx.cache.set(
        name,
        cache_key,
        ++cache_value,
        config.interval * 60 * 1000
      );
      if (cache_value <= config.uniqueDenyThreshold && cache_value > 1) {
        logger.info(`${session.event.user.id} 短时重复申请`);
        await session.bot.handleGuildMemberRequest(
          session.messageId,
          false,
          session.text("group-inspector.messages.frequency_deny", [
            config.interval,
          ])
        );

        if (config.enableManualApproval) {
          await sendRequestNotification(session, "rejected", {
            reason: "短时重复申请",
          });
        }
        return;
      }

      for (let group of config.groups) {
        for await (let member of session.bot.getGuildMemberIter(group)) {
          if (session.userId === member.user.id) {
            if (cache_value <= config.uniqueDenyThreshold) {
              logger.info(`${session.event.user.id} 重复加群`);
              await session.bot.handleGuildMemberRequest(
                session.messageId,
                false,
                session.text("group-inspector.messages.frequency_deny", [
                  config.interval,
                ])
              );

              if (config.enableManualApproval) {
                await sendRequestNotification(session, "rejected", {
                  reason: "重复加群",
                });
              }
              return;
            }
            break;
          }
        }
      }
    }

    // 第二步：检查是否应该自动通过
    const shouldAccept = await shouldAutoAccept(session);
    if (shouldAccept) {
      logger.info(`${session.event.user.id} 符合自动通过规则`);
      await session.bot.handleGuildMemberRequest(session.messageId, true, "");

      if (config.enableManualApproval) {
        await sendRequestNotification(session, "approved");
      }
      return;
    }

    // 第三步：如果既不拒绝也不自动通过，则进入手动审批
    if (config.enableManualApproval) {
      const requestKey = `member:${session.userId}:${session.guildId}`;

      // 清理之前的相同请求
      cleanupActiveRequest(requestKey);

      logger.info(`${session.event.user.id} 进入手动审批流程`);
      if (config.enableDebug) {
        logger.debug(`审批通知目标: ${config.notifyTarget}`);
      }
      await setupManualHandling(session, requestKey);
    } else {
      // 如果未启用手动审批，默认不处理（即不通过也不拒绝）
      logger.info(`${session.event.user.id} 未匹配任何规则，且未启用手动审批`);
    }
  });
}
