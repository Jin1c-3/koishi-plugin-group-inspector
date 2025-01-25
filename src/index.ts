import { Context, Schema } from "koishi";

export const name = "group-inspector";

export const reusable = true;

export const usage = `推荐使用[NapCat](https://napneko.github.io/)，入群形式使用**验证消息**

本插件和进群验证类插件不同，本插件会尝试自动拒绝部分用户的入群申请

此外本插件是[可重用插件](https://koishi.chat/zh-CN/guide/plugin/lifecycle.html#%E5%8F%AF%E9%87%8D%E7%94%A8%E6%8F%92%E4%BB%B6)，使用前要自行配置过滤器，插件会在过滤器中的**所有群组**中生效

QQ群组直接将**频道ID**设置为**QQ群号**即可，多个群号使用**或**逻辑连接

拒绝信息可以前往**本地化**模块自行修改，注意不要超过**30**字，这是腾讯的规定`;

export interface Config {
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
    interval: Schema.number().required().default(5),
  }),

  Schema.intersect([
    Schema.object({
      levelEnable: Schema.boolean().default(false),
    }),
    Schema.union([
      Schema.object({
        levelEnable: Schema.const(true).required(),
        levelFloor: Schema.natural().required().default(10),
        levelDenyThreshold: Schema.natural().required().default(2),
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
        uniqueDenyThreshold: Schema.natural().required().default(2),
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
        requestMatchList: Schema.array(String)
          .role("table")
          .required()
          .default(["管理员你好，我是来交流学习的，请通过一下", "通过一下"]),
      }),
      Schema.object({}),
    ]),
  ]),
]).i18n({ "zh-CN": require("./locales/zh-CN")._config });

export function apply(ctx: Context) {
  ctx.i18n.define("zh-CN", require("./locales/zh-CN"));
}
