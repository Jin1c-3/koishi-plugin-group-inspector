import { Context, Schema } from "koishi";
import {} from "@koishijs/cache";
import {} from "koishi-plugin-adapter-onebot";

export const inject = {
  required: ["cache"],
};

export const name = "group-inspector";

export const reusable = true;
export const usage = `本插件用于自动识别并拒绝特定的入群申请。主要特点：

- 作为可重用插件运行，支持多实例部署
- 可以自动拒绝低等级申请，推荐使用 [NapCat](https://napneko.github.io/)
- 支持自定义拒绝理由，请在**本地化**模块中修改（注意：腾讯限制<u>最多**30**字</u>）

更多使用说明请参考配置界面的选项说明。`;

declare module "@koishijs/cache" {
  interface Tables {
    "group-inspector": number;
  }
}

export interface Config {
  groups?: string[];
  interval?: number;
  levelEnable?: boolean;
  levelFloor?: number;
  levelDenyThreshold?: number;
  uniqueEnable?: boolean;
  uniqueDenyThreshold?: number;
  requestMatchEnable?: boolean;
  requestMatchList?: string[];
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
      levelEnable: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        levelEnable: Schema.const(true).required(),
        levelFloor: Schema.natural().default(10),
        levelDenyThreshold: Schema.natural().default(2),
      }),
      Schema.object({}),
    ]),
  ]),

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
      requestMatchEnable: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        requestMatchEnable: Schema.const(true).required(),
        requestMatchList: Schema.array(Schema.string()).default([
          "管理员你好，我是来交流学习的，请通过一下",
          "通过一下",
          "管理员你好",
        ]),
      }),
      Schema.object({}),
    ]),
  ]),
]).i18n({ "zh-CN": require("./locales/zh-CN")._config });

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define("zh-CN", require("./locales/zh-CN"));
  const logger = ctx.logger(name);
  ctx.on("guild-member-request", async (session) => {
    // 肯定是广告狗
    if (config.requestMatchEnable) {
      const answer = (await session.event._data.comment).match(
        /问题：.*\n答案：(.*)/
      )?.[1];
      for (let request of config.requestMatchList) {
        if (answer == request) {
          logger.info(`${session.event.user.id}广告狗`);
          await session.bot.handleGuildMemberRequest(
            session.messageId,
            false,
            session.text("groups-inspector.messages.ad_deny")
          );
          return;
        }
      }
    }
    // 判断等级
    if (config.levelEnable) {
      const strangerInfo = await session.bot.internal.getStrangerInfo(
        session.userId
      );
      const level = strangerInfo?.qqLevel;
      if (level === undefined) {
        logger.warn("your adapter does not support qqLevel!");
      } else {
        if (level === 0) {
          logger.info(`${session.event.user.id}获取等级失败`);
        } else if (level < config.levelFloor) {
          let cache_key = `${session.userId}-level`;
          let cache_value = (await ctx.cache.get(name, cache_key)) || 0;
          await ctx.cache.set(
            name,
            cache_key,
            ++cache_value,
            config.interval * 60 * 1000
          );
          if (cache_value <= config.levelDenyThreshold) {
            logger.info(`${session.event.user.id}的等级为${level}，等级低`);
            await session.bot.handleGuildMemberRequest(
              session.messageId,
              false,
              session.text("groups-inspector.messages.ad_deny")
            );
            return;
          }
        }
      }
    }
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
        logger.info(`${session.event.user.id}短时重复申请`);
        await session.bot.handleGuildMemberRequest(
          session.messageId,
          false,
          session.text("groups-inspector.messages.frequency_deny", [
            config.interval,
          ])
        );
        return;
      }
      for (let group of config.groups) {
        for await (let member of session.bot.getGuildMemberIter(group)) {
          if (session.userId === member.user.id) {
            if (cache_value <= config.uniqueDenyThreshold) {
              logger.info(`${session.event.user.id}重复加群`);
              await session.bot.handleGuildMemberRequest(
                session.messageId,
                false,
                session.text("groups-inspector.messages.frequency_deny", [
                  config.interval,
                ])
              );
              return;
            }
            break;
          }
        }
      }
    }
  });
}
