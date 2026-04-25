import { Context, Schema } from 'koishi'

// 扩展 Tables 接口
declare module 'koishi' {
  interface Tables {
    dividend_log: {
      id: number
      date: Date
      userId: string
      amount: number
    }
    // 声明 bourse_history 表结构（只需要你使用的字段）
    bourse_history: {
      id: number
      stockId: string
      price: number
      time: Date
    }
    // 声明 bourse_holding 表结构
    bourse_holding: {
      userId: string
      stockId: string
      amount: number
    }
    username: {
      userId: string
      uid: number
      username: string
      platform: string
      channelId: string
    }
    user_trade_history: {
      user_id: string
      uid: number
      total_profit: number
      total_count: number
      last_trade_at: Date
    }
    bourse_pending: {
      id: number
      userId: string
      uid: number
      stockId: string
      type: 'buy' | 'sell'
      amount: number
      price: number
      cost: number
      startTime: Date
      endTime: Date
    }
  }
  interface Events {
    'bourse/sell-settled': (txn: {
      id: number
      userId: string
      uid: number
      stockId: string
      type: 'sell'
      amount: number
      price: number
      cost: number
      profit: "double",
      startTime: Date
      endTime: Date
    }) => void
  }
  interface Context {
    monetary: {
      gain(userId: number, amount: number): Promise<void>
      cost(userId: number, amount: number): Promise<void>
      get(userId: number): Promise<number>
    }
    cron(expression: string, callback: () => Promise<void>): void
  }
}

export const name = 'monetary-bourse-expansion'
export const inject = {
  required: ['database', 'monetary', 'cron'],
  optional: []
}
export interface Config {
  currencyName: string// 显示的货币名称
  enableDividend: boolean// 是否启用股利发放功能
  dividendSchedule: string// 定时任务的 cron 表达式
  randomRatioMin: number// 随机股利比率下限比率百分比（0~10）
  randomRatioMax: number// 随机股利比率上限比率百分比（0~10）
  enableProfitTracking: boolean// 是否启用卖出收益追踪
  debugMode: boolean// 调试模式，为 true 时输出所有日志，为 false 时只输出 warn 和 error
}

export const Config: Schema<Config> = Schema.object({
  currencyName: Schema.string()
    .default('桐币')
    .description('使用的货币名称'),
  enableDividend: Schema.boolean()
    .default(true)
    .description('是否启用股利发放功能'),
  dividendSchedule: Schema.string()
    .default('0 0 * * 1')        // 默认每周一0点
    .description('定时任务的 cron 表达式，例如每周一0点：0 0 * * 1'),
  randomRatioMin: Schema.number()
    .default(0)
    .min(0)
    .max(10)
    .description('随机股利下限比率百分比'),
  randomRatioMax: Schema.number()
    .default(1)
    .min(0)
    .max(10)
    .description('随机股利上限比率百分比'),
  enableProfitTracking: Schema.boolean()
    .default(true)
    .description('是否启用卖收益追踪功能'),
  debugMode: Schema.boolean()
    .default(true)
    .description('开启调试日志（显示 info/success 等非 error/warn 日志）'),
})

export function apply(ctx: Context, config: Config) {
  const logger = {
    info: (msg: string) => config.debugMode && ctx.logger.info(msg),
    success: (msg: string) => config.debugMode && ctx.logger.success(msg),
    warn: (msg: string) => ctx.logger.warn(msg),
    error: (msg: string) => ctx.logger.error(msg),
  }

  // 扩展数据库表：用于记录股利发放日志，防止重复发放
  ctx.database.extend('dividend_log', {
    id: 'unsigned',// 自增主键
    date: 'timestamp',// 发放日期（只记录年月日，时分为0）
    userId: 'string',// 用户ID
    amount: 'float',// 发放的股利金额
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['date', 'userId']],
  })
  // 获取今日零点的时间戳（用于日志查询）
  function getTodayMidnight(): Date {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now
  }
  // 核心函数：执行股利发放
  async function distributeDividend() {
    // 如果未启用股利功能，直接返回
    if (!config.enableDividend || config.randomRatioMax <= 0) {
      logger.info('股利发放功能已禁用或股利比率为0，跳过发放')
      return
    }
    const today = getTodayMidnight()
    logger.info(`开始发放股利 (日期: ${today.toISOString().slice(0, 10)})`)

    // 检查今日是否已经发放过
    const { start, end } = (() => {
      const now = new Date()
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const e = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      return { start: s, end: e }
    })()
    const existingLogs = await ctx.database.get('dividend_log', {
      date: { $gte: start, $lt: end }
    })
    if (existingLogs.length > 0) {
      logger.info(`今日 (${today.toISOString().slice(0, 10)}) 已经发放过股利，跳过执行`)
      return
    }
    // 获取所有股票的最新价格（从 bourse_history 表）
    async function getLatestPrices(): Promise<Map<string, number>> {

      // 获取所有股票 ID
      const allHistory = await ctx.database.get('bourse_history', {}, { fields: ['stockId'] });
      const stockIds = [...new Set(allHistory.map(r => r.stockId))];
      if (stockIds.length === 0) return new Map()

      // 获取每个股票的最新时间戳
      const priceMap = new Map<string, number>()
      for (const stockId of stockIds) {
        const latest = await ctx.database.get('bourse_history', { stockId }, {
          sort: { time: 'desc' },
          limit: 1,
        })
        if (latest[0]) {
          priceMap.set(stockId, latest[0].price)
        }
      }
      logger.success(`获取到 ${stockIds.length} 支股票的最新价格`)
      return priceMap
    }
    // 从 bourse_holding 表中查询所有持仓记录
    const holdings = await ctx.database.get('bourse_holding', {})

    if (!holdings || holdings.length === 0) {
      logger.info('没有找到任何持仓记录，股利发放结束')
      return
    }

    // 获取所有股票的最新价格
    const latestPrices = await getLatestPrices()
    if (latestPrices.size === 0) {
      logger.warn('无法获取股票最新价格，股利发放中止')
      return
    }

    // 生成本次发放的随机比率（0 ~ randomRatioMax）
    const ratio = (config.randomRatioMin + Math.random() * (config.randomRatioMax - config.randomRatioMin)) / 100
    logger.info(`本次股利发放随机比率: ${(ratio * 100).toFixed(2)}%`)

    // 更新所有股票的价格并记录到 bourse_history
    const now = new Date()// 当前时间作为价格记录时间
    // 获取所有被持仓的股票 ID
    const heldStockIds = new Set(holdings.map(h => h.stockId))
    const priceRecords = [];
    for (const [stockId, currentPrice] of latestPrices.entries()) {
      if (!heldStockIds.has(stockId)) continue// 跳过无持仓的股票
      // 新价格 = 原价格 * (1 - 比率)
      let newPrice = Math.round(currentPrice * (1 - ratio) * 100) / 100
      // 避免价格出现负数（极小情况）
      if (newPrice < 0) newPrice = 0
      priceRecords.push({ stockId, price: newPrice, time: now });
    }
    // 在循环外，将所有价格记录一次性插入
    if (priceRecords.length) {
      await ctx.database.upsert('bourse_history', priceRecords);
    }

    // 按用户汇总应得股利（遍历每一条持仓，根据股票最新价格计算）
    let hasAnyAmount = false
    const userDividendMap = new Map<string, number>()

    for (const holding of holdings) {
      const userId = holding.userId
      const stockId = holding.stockId
      const amount = holding.amount || 0
      if (amount <= 0) continue

      hasAnyAmount = true   // 标记存在正数持仓

      const currentPrice = latestPrices.get(stockId)
      if (!currentPrice) {
        logger.warn(`股票 ${stockId} 无最新价格，跳过该持仓`)
        continue
      }

      const dividend = Math.round(amount * currentPrice * ratio)
      if (dividend <= 0) continue

      userDividendMap.set(userId, (userDividendMap.get(userId) || 0) + dividend)
    }
    if (!hasAnyAmount) {
      logger.info('所有用户持仓数量为0，无需发放股利')
      return
    }

    // 执行发放
    let totalDistributed = 0
    let successCount = 0
    const dividendRecords = [];
    // 批量获取用户 uid（根据 userId），避免在循环内重复查询数据库
    const userIds = Array.from(userDividendMap.keys())
    const userRecords = await ctx.database.get('username', { userId: { $in: userIds } })
    const uidMap = new Map(userRecords.map(r => [r.userId, r.uid]))
    for (const [userId, dividend] of userDividendMap.entries()) {
      try {
        const uid = uidMap.get(userId)
        if (!uid) {
          logger.warn(`用户 ${userId} 没有 uid，跳过发放`)
          continue
        }
        await ctx.monetary.gain(uid, dividend)
        totalDistributed += dividend
        successCount++
        logger.success(`用户 ${userId} 获得股利 ${dividend}`)
        dividendRecords.push({ date: today, userId, amount: dividend })//写入发放日志
      } catch (error) {
        logger.error(`为用户 ${userId} 发放股利失败: ${error instanceof Error ? error.message : error}`)
      }
    }
    // 在循环外，将所有股利记录一次性插入
    if (dividendRecords.length) {
      await ctx.database.upsert('dividend_log', dividendRecords);
    }

    logger.info(`股利发放完成，共发放给 ${successCount} 位用户，总金额: ${totalDistributed}`)
  }
  // 注册定时任务
  ctx.cron(config.dividendSchedule, async () => {
    try {
      await distributeDividend()
    } catch (error) {
      logger.error(`股利发放任务执行失败: ${error instanceof Error ? error.message : error}`)
    }
  })
  logger.info(`股利发放定时任务已注册，调度规则: ${config.dividendSchedule}`)
  // 注册手动触发命令（仅管理员可用）
  ctx.command('stock.dividend', '手动触发股利发放', { authority: 4 })
    .alias('stock.发股利').alias('stock.發股利')
    .action(async () => {
      await distributeDividend()
      return '股利发放任务已执行。'
    })

  // 卖出收益追踪功能
  if (config.enableProfitTracking) {
    // 扩展历史收益表
    ctx.database.extend('user_trade_history', {
      user_id: 'string',
      uid: 'unsigned',
      total_profit: 'float',
      total_count: 'integer',
      last_trade_at: 'timestamp',
    }, {
      primary: 'user_id',
    })

    // 监听原始插件发出的卖出结算事件
    ctx.on('bourse/sell-settled', async (txn) => {
      // txn 结构来自 bourse_pending 表
      if (!txn.userId || !txn.uid || txn.profit == null) {
        logger.warn(`卖出订单缺少必要字段: ${JSON.stringify(txn)}`)
        return
      }

      const profit = Number(txn.profit)  // 已经是净收益
      const [history] = await ctx.database.get('user_trade_history', { user_id: txn.userId })

      if (history) {
        await ctx.database.set('user_trade_history', { user_id: txn.userId }, {
          total_profit: history.total_profit + profit,
          total_count: history.total_count + 1,
          last_trade_at: new Date(),
        })
        logger.info(`用户 ${txn.userId} 卖出收益 +${profit} (总收益: ${history.total_profit + profit})`)
      } else {
        await ctx.database.create('user_trade_history', {
          user_id: txn.userId,
          uid: txn.uid,
          total_profit: profit,
          total_count: 1,
          last_trade_at: new Date(),
        })
        logger.info(`用户 ${txn.userId} 首次卖出收益记录: ${profit}`)
      }
    })

    // 排行查询命令
    ctx.command('stock.profitrank', '查看累计卖出收益排行', { authority: 1 })
      .alias('stock.收益排行')
      .action(async ({ session }) => {
        const limit = 10  // 显示前10名，可根据需要调整

        const currentChannelId = session.channelId

        // 1. 获取当前频道下的所有用户（从 username 表）
        const usersInChannel = await ctx.database.get('username', {
          platform: session.platform,
          channelId: currentChannelId
        })
        if (!usersInChannel.length) {
          return '本群暂无用户数据，请稍後再试。'
        }
        const userIds = usersInChannel.map(u => u.userId)
        // 2. 查询这些用户的收益记录
        const records = await ctx.database.get('user_trade_history', {
          user_id: { $in: userIds }
        }, {
          sort: { total_profit: 'desc' },
          limit: limit
        })

        if (!records.length) {
          return '本群暂无卖出收益记录。'
        }

        // 3. 构建 userId -> username 的映射
        const nameMap = new Map(usersInChannel.map(u => [u.userId, u.username || u.userId]))

        const lines = ['🏆 本群累计卖出收益排行 🏆']
        for (let i = 0; i < records.length; i++) {
          const r = records[i]
          const displayName = nameMap.get(r.user_id) || r.user_id
          const profit = r.total_profit.toFixed(2)
          lines.push(`${i + 1}. ${displayName}：${profit} ${config.currencyName}`)
        }
        return lines.join('\n')
      })
  }
}
