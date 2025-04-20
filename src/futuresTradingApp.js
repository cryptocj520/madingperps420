const TradingApp = require('./app');
const BackpackFuturesService = require('./services/backpackFuturesService');
const FuturesTradingStrategyModule = require('./core/futuresTradingStrategy');
const OrderManagerService = require('./core/orderManager');
const { OrderManager } = require('./models/Order');
const TradeStats = require('./models/TradeStats');
const { log, defaultLogger } = require('./utils/logger');
const TimeUtils = require('./utils/timeUtils');
const Formatter = require('./utils/formatter');

/**
 * 合约交易应用类 - 扩展基础交易应用实现合约特有功能
 */
class FuturesTradingApp extends TradingApp {
  /**
   * 持仓信息
   * @type {boolean} hasOpenPosition - 是否有持仓
   * @type {number} positionAmount - 持仓数量
   * @type {number} entryPrice - 开仓价格
   * @type {number} unrealizedPnl - 未实现盈亏
   * @type {string} positionSide - 持仓方向(LONG/SHORT)
   * @type {number} stopLossPrice - 止损价格
   * @type {number} takeProfitPrice - 止盈价格
   * @type {boolean} takeProfitTriggered - 止盈触发标志
   * @type {number} lastPositionCheckTime - 上次持仓检查时间
   */
  constructor(config, services = {}) {
    super(config, services);
    
    // 使用配置的logger或默认logger
    if (!this.logger) {
      this.logger = defaultLogger;
    }
    
    // 确保配置对象存在
    this.config = config || {};
    
    // 确保actions配置存在
    if (!this.config.actions) {
      this.config.actions = {};
    }
    
    // 确保trading配置存在 - 添加这个确保父类方法可以访问takeProfitPercentage
    if (!this.config.trading) {
      this.config.trading = {};
    }
    
    // 添加默认配置值
    this.config.actions.closeAllPositionsOnStop = 
      typeof this.config.actions.closeAllPositionsOnStop !== 'undefined' 
        ? this.config.actions.closeAllPositionsOnStop 
        : true;
    
    // 设置默认不取消现有订单，优先保留已创建的订单等待成交
    this.config.actions.cancelExistingOrdersOnStart =
      typeof this.config.actions.cancelExistingOrdersOnStart !== 'undefined'
        ? this.config.actions.cancelExistingOrdersOnStart
        : false;
    
    // 从futures配置复制takeProfitPercentage到trading配置
    if (this.config.futures && this.config.futures.takeProfitPercentage !== undefined) {
      this.config.trading.takeProfitPercentage = this.config.futures.takeProfitPercentage;
    }
    
    // 合约交易服务 - 确保直接使用而不是依赖父类服务
    this.tradingService = new BackpackFuturesService(config, this.logger);
    
    // 交易策略 - 确保使用正确的类和路径
    try {
      // 确保清除任何可能存在的缓存
      delete require.cache[require.resolve('./core/futuresTradingStrategy')];
      const FuturesTradingStrategyClass = require('./core/futuresTradingStrategy');
      log(`已成功导入FuturesTradingStrategy类`);
      
      this.tradingStrategy = new FuturesTradingStrategyClass(this.logger, this.config);
      
      // 验证实例是否创建成功
      if (!this.tradingStrategy) {
        log('错误: 无法创建tradingStrategy实例', true);
      } else {
        log(`tradingStrategy实例创建成功, 类型: ${this.tradingStrategy.constructor.name}`);
        log(`可用方法: ${Object.getOwnPropertyNames(Object.getPrototypeOf(this.tradingStrategy))}`);
        
        // 直接设置calculateFuturesOrders方法
        log('设置calculateFuturesOrders方法');
        
        // 定义合约订单计算方法
        let futuresOrdersCalculator = function(
          currentPrice,
          maxDropPercentage,
          totalAmount,
          orderCount,
          incrementPercentage,
          minOrderAmount,
          tradingCoin,
          symbol
        ) {
          // 基于持仓方向计算价格区间
          let lowestPrice, highestPrice, priceStep;
          const isLong = this.positionSide === 'LONG';
          
          if (isLong) {
            // 做多策略 - 在下跌过程中分批买入
            lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
            priceStep = (currentPrice - lowestPrice) / (orderCount - 1);
          } else {
            // 做空策略 - 在上涨过程中分批做空
            highestPrice = currentPrice * (1 + maxDropPercentage / 100);
            priceStep = (highestPrice - currentPrice) / (orderCount - 1);
          }
          
          // 使用父类方法计算基本订单结构
          const orders = this.calculateIncrementalOrders(
            currentPrice,
            maxDropPercentage,
            totalAmount,
            orderCount,
            incrementPercentage,
            minOrderAmount,
            tradingCoin,
            symbol
          );
          
          // 为每个订单添加合约特有的属性
          orders.forEach(order => {
            order.positionSide = this.positionSide || 'LONG';
            order.leverage = this.leverage || 5;
          });
          
          if (!orders || orders.length === 0) {
            log('无法生成有效订单序列，请检查交易参数', true);
            return;
          }
          
          return orders;
        };
        
        // 绑定函数到tradingStrategy实例
        this.tradingStrategy.calculateFuturesOrders = futuresOrdersCalculator.bind(this.tradingStrategy);
      }
    } catch (initError) {
      log(`tradingStrategy初始化失败: ${initError.message}`, true);
      log(`错误堆栈: ${initError.stack}`, true);
      // 创建基本的tradingStrategy实例
      const TradingStrategyClass = require('./core/tradingStrategy');
      this.tradingStrategy = new TradingStrategyClass(this.logger, this.config);
      log('已使用基础TradingStrategy作为后备');
    }
    
    // 合约特有属性
    this.tradingCoin = config.futures?.tradingCoin || 'BTC';
    this.positionSide = config.futures?.positionSide || 'LONG';  // 持仓方向：LONG或SHORT
    this.leverage = config.futures?.leverage || 1;  // 杠杆倍数
    this.tradingType = config.futures?.tradingType || 'linear';  // 合约类型：linear(USDC结算)或inverse(币本位)
    
    // 确保riskManagement配置存在
    if (!this.config.riskManagement) {
      this.config.riskManagement = {};
    }
    
    // 风险管理参数
    this.stopLossPercentage = this.config.riskManagement.stopLossPercentage || 3;  // 止损百分比
    this.dynamicStopLoss = this.config.riskManagement.dynamicStopLoss || false;  // 是否启用动态止损
    this.trailingStopActivation = this.config.riskManagement.trailingStopActivation || 1;  // 追踪止损激活点
    this.trailingStopDistance = this.config.riskManagement.trailingStopDistance || 0.5;  // 追踪止损距离
    
    // 订单参数
    this.totalAmount = config.futures?.totalAmount || 100; // 总投资金额
    this.takeProfitPercentage = config.futures?.takeProfitPercentage || 0.5; // 止盈百分比
    
    // 合约交易状态
    this.hasOpenPosition = false;
    this.positionAmount = 0;
    this.entryPrice = 0;
    this.unrealizedPnl = 0;
    this.stopLossPrice = 0;
    this.takeProfitPrice = 0;
    this.takeProfitTriggered = false;
    
    // 添加平仓原因跟踪
    this.lastPositionClosedReason = null;
    
    // 风险控制 - 是否能够获取持仓信息
    this.canFetchPositions = true;
    
    // 初始化持仓检查时间
    this.lastPositionCheckTime = Date.now();
    
    // 初始化监控间隔
    this.monitoringInterval = null;
    
    // 将tradingService赋值给backpackService以兼容现有代码
    this.backpackService = this.tradingService;
  }
  
  /**
   * 初始化交易环境 - 重写基类方法以适应合约交易
   */
  async initialize() {
    try {
      log('正在初始化合约交易环境...');
      
      // 调用父类初始化方法
      await super.initialize();
      
      // 设置合约交易对
      // 确保使用与交易服务相同的符号格式
      this.symbol = this.tradingService.symbol;
      
      // 记录合约特有配置
      log(`合约交易对: ${this.symbol}`);
      log(`持仓方向: ${this.positionSide}`);
      log(`杠杆倍数: ${this.leverage}x`);
      log(`合约类型: ${this.tradingType === 'linear' ? '线性合约(USDC结算)' : '反向合约(币本位)'}`);
      
      // 记录取消现有订单设置
      log(`启动时取消现有订单: ${this.config.actions.cancelExistingOrdersOnStart ? '是' : '否'}`);
      if (!this.config.actions.cancelExistingOrdersOnStart) {
        log('将保留现有未成交订单，等待成交。如需在启动时取消订单，请在配置中设置 actions.cancelExistingOrdersOnStart = true');
      }
      
      // 获取账户信息
      try {
        const accountInfo = await this.tradingService.getAccountInfo();
        if (accountInfo) {
          log('账户信息获取成功');
          if (accountInfo.commissionTier !== undefined) {
            log(`手续费等级: ${accountInfo.commissionTier}`);
          }
          if (accountInfo.balances && accountInfo.balances.length > 0) {
            log('账户余额:');
            accountInfo.balances.forEach(balance => {
              if (parseFloat(balance.available) > 0) {
                log(`- ${balance.asset}: ${balance.available} (可用), ${balance.locked || 0} (冻结)`);
              }
            });
          }
        }
      } catch (error) {
        log(`获取账户信息失败: ${error.message}`, true);
        // 继续初始化流程
      }
      
      // 设置杠杆倍数
      try {
        await this.setLeverage();
        log(`杠杆倍数已设置为 ${this.leverage}x`);
      } catch (error) {
        log(`设置杠杆倍数失败: ${error.message}`, true);
        // 不阻止程序继续执行
      }
      
      // 查询现有仓位
      await this.checkExistingPositions();
      
      // 设置定时器，5秒后执行交易
      setTimeout(async () => {
        log('程序启动5秒后自动执行交易策略...');
        await this.executeTrade();
      }, 5000);
      
      return true;
    } catch (error) {
      log(`合约交易初始化失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 设置杠杆倍数
   */
  async setLeverage() {
    try {
      await this.tradingService.setLeverage(this.symbol, this.leverage);
    } catch (error) {
      log(`设置杠杆倍数失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 检查现有合约仓位
   */
  async checkExistingPositions() {
    try {
      // 使用新的API获取持仓信息
      const positions = await this.tradingService.getPositions();
      
      if (positions && positions.length > 0) {
        log('检测到持仓信息:');
        
        // 筛选当前交易对的持仓
        const currentPosition = positions.find(pos => pos.symbol === this.symbol);
        
        if (currentPosition) {
          this.hasOpenPosition = true;
          this.positionAmount = parseFloat(currentPosition.netQuantity || currentPosition.netExposureQuantity || 0);
          this.entryPrice = parseFloat(currentPosition.entryPrice);
          this.unrealizedPnl = parseFloat(currentPosition.pnlUnrealized || 0);
          this.positionSide = this.positionAmount > 0 ? 'LONG' : 'SHORT';
          
          log(`检测到${this.positionSide === 'LONG' ? '多' : '空'}仓位:`);
          log(`- 持仓数量: ${Math.abs(this.positionAmount)} ${this.tradingCoin}`);
          log(`- 开仓均价: ${this.entryPrice} USDC`);
          log(`- 未实现盈亏: ${this.unrealizedPnl} USDC`);
          
          if (currentPosition.estLiquidationPrice) {
            log(`- 预估强平价格: ${currentPosition.estLiquidationPrice} USDC`);
          }
        } else {
          log(`未检测到${this.tradingCoin}的持仓`);
          this.hasOpenPosition = false;
        }
      } else {
        log('未检测到任何合约仓位');
        this.hasOpenPosition = false;
      }
    } catch (error) {
      log(`检查合约仓位失败: ${error.message}`, true);
    }
  }
  
  /**
   * 获取当前市场价格
   * @returns {Promise<number|null>} 当前价格
   */
  async getMarketPrice() {
    try {
      log('获取当前市场价格...');
      
      // 先尝试使用当前价格信息
      if (this.currentPriceInfo && this.currentPriceInfo.price) {
        log(`使用WebSocket最新价格: ${this.currentPriceInfo.price}`);
        return parseFloat(this.currentPriceInfo.price);
      }
      
      // 否则通过REST API获取
      try {
        const ticker = await this.tradingService.getFuturesTicker(this.tradingService.symbol);
        
        if (ticker && ticker.lastPrice) {
          const price = parseFloat(ticker.lastPrice);
          log(`通过API获取最新价格: ${price}`);
          return price;
        }
      } catch (error) {
        log(`通过API获取价格失败: ${error.message}`, true);
        
        // 尝试使用父类方法
        try {
          const priceInfo = await super.getPriceInfo();
          if (priceInfo && priceInfo.price) {
            log(`使用父类方法获取价格: ${priceInfo.price}`);
            return parseFloat(priceInfo.price);
          }
        } catch (err) {
          log(`父类价格获取也失败: ${err.message}`, true);
        }
      }
      
      log('无法获取有效价格信息', true);
      return null;
    } catch (error) {
      log(`获取市场价格失败: ${error.message}`, true);
      return null;
    }
  }
  
  /**
   * 获取持仓信息
   */
  async getPositionInfo() {
    try {
      // 使用新的getPositions方法获取持仓数据
      const positions = await this.tradingService.getPositions();
      
      // 能够成功获取持仓数据，更新标志
      this.canFetchPositions = true;
      
      if (positions && positions.length > 0) {
        // 有持仓
        log(`获取到 ${positions.length} 个持仓`);
        
        // 更新持仓状态
        this.hasOpenPosition = true;
        
        // 获取第一个持仓
        const position = positions[0];
        
        // 从API返回的数据结构中获取字段
        this.positionAmount = parseFloat(position.netQuantity || position.netExposureQuantity || 0);
        this.entryPrice = parseFloat(position.entryPrice || 0);
        this.unrealizedPnl = parseFloat(position.pnlUnrealized || 0);
        this.positionSide = this.positionAmount > 0 ? 'LONG' : 'SHORT';
        
        log(`当前持仓: ${this.positionSide} ${Math.abs(this.positionAmount)} @ ${this.entryPrice}`);
        log(`未实现盈亏: ${this.unrealizedPnl} USDC (${((this.unrealizedPnl / (this.entryPrice * Math.abs(this.positionAmount))) * 100).toFixed(2)}%)`);
        
        if (position.estLiquidationPrice) {
          log(`预估强平价格: ${position.estLiquidationPrice}`);
        }
        
        return positions;
      } else {
        // 无持仓，重置持仓状态
        this.hasOpenPosition = false;
        this.positionAmount = 0;
        this.entryPrice = 0;
        this.unrealizedPnl = 0;
        log('当前无持仓');
        return [];
      }
    } catch (error) {
      log(`获取持仓信息失败: ${error.message}`, true);
      // 无法获取持仓数据，更新标志
      this.canFetchPositions = false;
      return [];
    }
  }
  
  /**
   * 执行交易策略
   * @returns {Promise<void>}
   */
  async executeTrade() {
    try {
      log('执行交易策略...');
      
      // 获取当前市场价格
      const currentPrice = await this.getMarketPrice();
      if (!currentPrice) {
        log('无法获取市场价格，无法执行交易', true);
        return;
      }
      
      log(`当前${this.symbol}市场价格: ${currentPrice}`);
      
      // 检查价格数据可靠性
      const priceDataAge = this.priceMonitor && this.priceMonitor.lastUpdateTime ? 
        (Date.now() - this.priceMonitor.lastUpdateTime) : Infinity;
      
      if (priceDataAge > 60000) { // 60秒
        log('⚠️ 价格数据超过60秒未更新，可能不可靠，暂停交易', true);
        return;
      }
      
      // 检查当前持仓状态
      await this.getPositionInfo();
      
      // 风险控制：如果无法获取持仓信息，不执行订单创建
      if (!this.canFetchPositions) {
        log('⚠️ 风险控制：无法获取持仓信息，跳过创建订单操作', true);
        return;
      }
      
      // 如果已有持仓，则不创建新订单
      if (this.hasOpenPosition) {
        log(`已有${this.positionSide}仓位，数量: ${Math.abs(this.positionAmount)}，不创建新订单`);
        
        // 设置或调整止损止盈
        if (!this.stopLossPrice || !this.takeProfitPrice) {
          log('检测到现有仓位没有止损止盈设置，现在设置...');
          await this.setPositionProtection(currentPrice);
        }
        
        log(`- 入场价格: ${this.entryPrice} USDC`);
        
        return;
      }
      
      try {
        // 检查是否有已存在的未成交订单
        const existingOrders = await this.tradingService.getOpenOrders(this.symbol);
        const hasExistingOrders = existingOrders && existingOrders.length > 0;
        
        // 仅当配置指定需要取消旧订单或没有现有订单时才创建新订单
        const shouldCancelExistingOrders = this.config.actions?.cancelExistingOrdersOnStart !== false;
        
        if (hasExistingOrders) {
          if (shouldCancelExistingOrders) {
            log(`检测到${existingOrders.length}个现有未成交订单，根据配置将取消它们并创建新订单`);
            // 取消现有未成交订单
            await this.cancelOpenOrders();
          } else {
            log(`检测到${existingOrders.length}个现有未成交订单，保留它们等待成交`);
            log(`如需取消现有订单并创建新订单，请在配置中设置 actions.cancelExistingOrdersOnStart = true`);
            return; // 有现有订单且配置为不取消，则直接返回不创建新订单
          }
        }
        
        // 无持仓，创建新马丁格尔多单序列
        log(`准备创建${this.positionSide === 'LONG' ? '多' : '空'}单序列（马丁格尔策略）`);
        
        // 添加开仓原因日志
        log('\n===== 开仓原因 =====');
        log(`当前价格: ${currentPrice} USDC`);
        if (this.config.actions?.cancelExistingOrdersOnStart && hasExistingOrders) {
          log(`原因: 存在未成交订单被取消后重新创建`);
        } else if (this.lastPositionClosedReason) {
          log(`原因: ${this.lastPositionClosedReason}`);
          this.lastPositionClosedReason = null; // 使用后重置
        } else if (!hasExistingOrders) {
          log(`原因: 无现有持仓，首次启动开仓`);
        }
        
        // 获取合约交易配置
        const maxDropPercentage = this.config.futures?.maxDropPercentage || 3; // 最大下跌百分比
        const totalAmount = this.config.futures?.totalAmount || 200; // 总投资金额
        const orderCount = this.config.futures?.orderCount || 3; // 订单数量
        const incrementPercentage = this.config.futures?.incrementPercentage || 50; // 递增百分比
        const tradingCoin = this.tradingCoin; // 交易币种
        
        log(`最大下跌百分比: ${maxDropPercentage}%`);
        log(`订单总金额: ${totalAmount} USDC`);
        log(`订单数量: ${orderCount}个`);
        log(`递增百分比: ${incrementPercentage}%`);
        
        // 获取币种的最小交易量和精度设置
        const minQuantity = this.config.minQuantities?.[tradingCoin] || 0.00001; // 最小交易量
        const quantityPrecision = this.config.quantityPrecisions?.[tradingCoin] || 5; // 数量精度
        const pricePrecision = this.config.pricePrecisions?.[tradingCoin] || 0; // 价格精度
        
        log(`${tradingCoin}交易精度配置 - 最小数量: ${minQuantity}, 数量精度: ${quantityPrecision}位, 价格精度: ${pricePrecision}位`);
        
        // 根据当前价格动态调整最小订单金额
        const minOrderAmount = Math.max(this.config.advanced?.minOrderAmount || 10, currentPrice * minQuantity);
        log(`当前最小订单金额: ${minOrderAmount.toFixed(2)} USDC`);
        
        // 使用父类的calculateIncrementalOrders方法
        log('使用通用递增订单计算方法...');
        const leveragedTotalAmount = totalAmount * this.leverage;
        log(`计算订单时考虑杠杆，实际计算金额: ${leveragedTotalAmount} USDC (${totalAmount} × ${this.leverage}倍杠杆)`);
        
        // 检查tradingStrategy是否存在
        if (!this.tradingStrategy) {
          log('错误: tradingStrategy对象不存在', true);
          return;
        }
        
        try {
          // 不使用tradingStrategy.calculateFuturesOrders，直接使用内联实现
          let orders;
          
          // 内联实现calculateFuturesOrders逻辑
          const isLong = this.positionSide === 'LONG';
          let lowestPrice, highestPrice, priceStep;
          
          if (isLong) {
            // 做多策略 - 在下跌过程中分批买入
            lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
            priceStep = (currentPrice - lowestPrice) / (orderCount - 1);
          } else {
            // 做空策略 - 在上涨过程中分批做空
            highestPrice = currentPrice * (1 + maxDropPercentage / 100);
            priceStep = (highestPrice - currentPrice) / (orderCount - 1);
          }
          
          // 使用tradingStrategy的calculateIncrementalOrders方法计算基本订单结构
          orders = this.tradingStrategy.calculateIncrementalOrders(
            currentPrice,
            maxDropPercentage,
            leveragedTotalAmount,
            orderCount,
            incrementPercentage,
            minOrderAmount,
            tradingCoin,
            this.symbol
          );
          
          // 为每个订单添加合约特有的属性
          orders.forEach(order => {
            order.positionSide = this.positionSide || 'LONG';
            order.leverage = this.leverage || 5;
          });
          
          if (!orders || orders.length === 0) {
            log('无法生成有效订单序列，请检查交易参数', true);
            return;
          }
          
          // 显示计划创建的订单
          log('\n=== 计划创建的订单 ===');
          let totalOrderAmount = 0;
          orders.forEach((order, index) => {
            log(`订单 ${index + 1}: 价格=${order.price} USDC, 数量=${order.quantity} ${tradingCoin}, 金额=${order.amount.toFixed(2)} USDC`);
            totalOrderAmount += order.amount;
          });
          log(`总订单金额: ${totalOrderAmount.toFixed(2)} USDC (预计使用杠杆: ${this.leverage}x)`);
          
          // 创建多个限价买单
          log('\n=== 开始创建订单 ===');
          let successCount = 0;
          let failedCount = 0;
          
          for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            try {
              log(`创建第 ${i+1}/${orders.length} 个订单: ${order.price} USDC, ${order.quantity} ${tradingCoin}`);
              
              // 创建限价买单 - 修复参数传递方式
              const orderData = {
                symbol: this.symbol,
                side: 'Buy', // 买入做多
                orderType: 'Limit', // 限价单
                quantity: order.quantity,
                price: order.price, // 限价单需要价格参数
                timeInForce: 'GTC'
              };
              
              const orderResult = await this.tradingService.createFuturesOrder(orderData);
              
              if (orderResult) {
                log(`订单创建成功，订单ID: ${orderResult.orderId || orderResult.id || 'unknown'}`);
                successCount++;
              } else {
                log(`订单创建失败: 未收到有效响应`, true);
                failedCount++;
              }
              
              // 延迟一下，避免API限制
              await new Promise(resolve => setTimeout(resolve, 1000));
              
            } catch (error) {
              log(`创建订单失败: ${error.message}`, true);
              failedCount++;
              
              // 如果是资金不足，停止后续订单创建
              if (error.message.includes('Insufficient') || error.message.includes('insufficient')) {
                log('资金不足，停止创建更多订单', true);
                break;
              }
            }
          }
          
          log(`订单创建完成: 成功 ${successCount}/${orders.length} 个, 失败 ${failedCount} 个`);
          
          // 启动止盈监控
          if (successCount > 0) {
            log('启动止盈监控...');
            // 删除可能存在的自动检查持仓逻辑，让定时任务来处理
            // 确保不会立即取消订单
            this.lastPositionCheckTime = Date.now(); // 重置无持仓检查时间，确保等待足够时间
            
            // 获取检查间隔时间并记录下次检查时间点
            const noFillRestartMinutes = Math.max(1, this.config.advanced?.noFillRestartMinutes || 30);
            const nextCheckTime = new Date(this.lastPositionCheckTime + noFillRestartMinutes * 60 * 1000);
            log(`创建订单成功，将在 ${nextCheckTime.toLocaleTimeString()} 检查订单是否成交（${noFillRestartMinutes}分钟后）`);
            
            // 如果监控还没启动，启动监控
            if (!this.monitoringInterval) {
              await this.startTakeProfitMonitoring();
            }
          }
        } catch (calcError) {
          log(`订单计算过程中出错: ${calcError.message}`, true);
          log(`错误堆栈: ${calcError.stack}`, true);
        }
      } catch (orderError) {
        log(`订单创建过程中出错: ${orderError.message}`, true);
        log(`错误堆栈: ${orderError.stack}`, true);
      }
    } catch (error) {
      log(`执行交易策略失败: ${error.message}`, true);
      log(`错误堆栈: ${error.stack}`, true);
    }
  }

  /**
   * 取消所有未成交订单
   */
  async cancelOpenOrders() {
    try {
      log('获取并取消未成交订单...');
      const openOrders = await this.tradingService.getOpenOrders(this.symbol);
      
      if (!openOrders || openOrders.length === 0) {
        log('没有未成交订单需要取消');
        return true;
      }
      
      log(`发现 ${openOrders.length} 个未成交订单，开始取消...`);
      
      const result = await this.tradingService.cancelAllOrders(this.symbol);
      log(`撤销订单结果: ${JSON.stringify(result || [])}`);
      
      // 等待一段时间，确保订单取消操作生效
      log('等待2秒，确保订单取消操作生效...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证订单是否真的被取消
      const remainingOrders = await this.tradingService.getOpenOrders(this.symbol);
      if (remainingOrders && remainingOrders.length > 0) {
        log(`警告: 仍有 ${remainingOrders.length} 个订单未被成功取消`, true);
        log(`这些订单可能会被继续执行，影响新的订单策略`, true);
        // 不返回失败，允许继续执行，但记录警告
      } else {
        log('确认所有订单已成功取消');
      }
      
      return result;
    } catch (error) {
      log(`取消订单失败: ${error.message}`, true);
      return false;
    }
  }

  /**
   * 设置仓位保护（止损止盈）
   * @param {number} currentPrice - 当前市场价格
   * @returns {Promise<boolean>} - 是否成功设置
   */
  async setPositionProtection(currentPrice) {
    try {
      if (!this.hasOpenPosition || Math.abs(this.positionAmount) <= 0) {
        log('没有持仓，无需设置止损止盈', true);
        return false;
      }

      log(`开始为${this.positionSide}仓位设置止损止盈...`);
      log(`- 入场价格: ${this.entryPrice} USDC`);
      log(`- 当前价格: ${currentPrice} USDC`);
      log(`- 持仓数量: ${Math.abs(this.positionAmount)} ${this.tradingCoin}`);

      // 计算止损价格 - 默认为入场价格的-3%（多仓）或+3%（空仓）
      const stopLossPercentage = this.stopLossPercentage || 3;
      this.stopLossPrice = this.positionSide === 'LONG' 
        ? this.entryPrice * (1 - stopLossPercentage / 100)
        : this.entryPrice * (1 + stopLossPercentage / 100);
      
      // 计算止盈价格 - 默认为入场价格的+0.5%（多仓）或-0.5%（空仓）
      const takeProfitPercentage = this.takeProfitPercentage || 0.5;
      this.takeProfitPrice = this.positionSide === 'LONG'
        ? this.entryPrice * (1 + takeProfitPercentage / 100)
        : this.entryPrice * (1 - takeProfitPercentage / 100);
      
      // 记录计算出的止损止盈价格
      log(`止损价格: ${this.stopLossPrice.toFixed(2)} USDC (${stopLossPercentage}%)`);
      log(`止盈价格: ${this.takeProfitPrice.toFixed(2)} USDC (${takeProfitPercentage}%)`);
      
      log('注意：Backpack API不支持直接设置止损止盈，将使用价格监控实现');
      log('开始监控止盈条件 (' + takeProfitPercentage + '%)...');
      
      // 由于Backpack不支持真正的止损止盈订单，我们将在价格监控中处理
      // 这里只是设置好价格，由价格监控部分处理
      return true;
    } catch (error) {
      log(`设置止损止盈失败: ${error.message}`, true);
      log(`错误堆栈: ${error.stack}`, true);
      return false;
    }
  }

  /**
   * 开始止盈监控 - 期货特有版本，覆盖基类方法
   * 在止盈后不重启程序，而是直接重新挂单
   */
  async startTakeProfitMonitoring() {
    if (!this.running) {
      log('应用程序未运行，无法开始监控止盈条件');
      return false;
    }
    
    // 先清理现有的监控循环（如果存在）
    if (this.monitoringInterval) {
      log('检测到已存在监控循环，清理后重新启动...');
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    // 获取止盈百分比
    const takeProfitPercentage = this.config.futures.takeProfitPercentage || 0.5;
    log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
    
    // 首次显示账户信息
    this.displayAccountInfo();
    
    // 监控变量
    let monitoringAttempts = 0;
    this.takeProfitTriggered = false;
    let lastPositionCheckTime = Date.now();
    
    // 无持仓等待相关参数
    const noFillRestartMinutes = Math.max(1, this.config.advanced?.noFillRestartMinutes || 30);
    const noFillIntervalMs = noFillRestartMinutes * 60 * 1000;
    
    // 记录无持仓等待配置
    log(`无持仓检测间隔: ${noFillRestartMinutes}分钟`);
    log(`下次无持仓检查时间: ${new Date(lastPositionCheckTime + noFillIntervalMs).toLocaleTimeString()}`);
    
    // 添加心跳计时器
    const heartbeatInterval = setInterval(() => {
      const timeNow = new Date().toLocaleString();
      this.logger.logToFile(`心跳检查: 脚本正在运行 ${timeNow}`);
    }, 60000);
    
    this.monitoringInterval = setInterval(async () => {
      try {
        monitoringAttempts++;
        
        // 记录每一轮监控的开始
        const cycleStartTime = Date.now();
        this.logger.logToFile(`开始第 ${monitoringAttempts} 轮合约持仓监控检查`);
        
        // 确保tradingStrategy存在
        if (!this.tradingStrategy || typeof this.tradingStrategy.calculateProfitPercentage !== 'function') {
          log('警告：tradingStrategy对象不存在或缺少必要方法，重新初始化', true);
          try {
            const FuturesTradingStrategy = require('./core/futuresTradingStrategy');
            log(`已导入FuturesTradingStrategy类: ${typeof FuturesTradingStrategy}`);
            this.tradingStrategy = new FuturesTradingStrategy(this.logger, this.config);
            
            // 验证初始化是否成功
            if (this.tradingStrategy && typeof this.tradingStrategy.calculateProfitPercentage === 'function') {
              log('tradingStrategy重新初始化成功');
            } else {
              log('tradingStrategy重新初始化后仍无法找到calculateProfitPercentage方法', true);
              log(`可用方法: ${Object.getOwnPropertyNames(Object.getPrototypeOf(this.tradingStrategy))}`, true);
            }
          } catch (initError) {
            log(`tradingStrategy初始化失败: ${initError.message}`, true);
            log(`错误堆栈: ${initError.stack}`, true);
          }
        }
        
        // 更新显示
        this.displayAccountInfo();
        
        // 检查持仓状态
        await this.getPositionInfo();
        
        // 如果有持仓，检查止盈条件
        if (this.hasOpenPosition && !this.takeProfitTriggered) {
          // 重置无持仓计时器，因为有持仓了
          lastPositionCheckTime = Date.now();
          
          // 获取当前市场价格
          const currentPrice = await this.getMarketPrice();
          if (!currentPrice) {
            log('无法获取市场价格，跳过止盈检查', true);
          } else {
            // 计算当前盈亏百分比
            const profitPercentage = this.tradingStrategy.calculateProfitPercentage(
              currentPrice,
              this.entryPrice,
              this.positionSide === 'LONG'
            );
            
            // 检查是否达到止盈条件
            const takeProfitReached = profitPercentage >= this.config.futures.takeProfitPercentage;
            
            // 记录当前持仓盈亏
            log(`未实现盈亏: ${this.unrealizedPnl.toFixed(5)} USDC (${profitPercentage.toFixed(2)}%)`);
            
            if (takeProfitReached) {
              log(`\n===== 止盈条件达成！=====`);
              log(`当前价格: ${currentPrice} USDC`);
              log(`入场价格: ${this.entryPrice} USDC`);
              log(`盈利: ${profitPercentage.toFixed(2)}% >= 止盈点: ${this.config.futures.takeProfitPercentage}%`);
              log('准备平仓获利...');
              
              // 设置止盈触发标志，避免重复触发
              this.takeProfitTriggered = true;
              
              // 记录平仓原因
              this.lastPositionClosedReason = `止盈平仓 - 盈利${profitPercentage.toFixed(2)}%达到设定值${this.config.futures.takeProfitPercentage}%`;
              
              // 执行止盈平仓操作
              await this.closePosition();
              
              // 平仓后，取消所有未成交订单
              await this.cancelOpenOrders();
              
              // 重置止盈触发标志和持仓状态
              this.takeProfitTriggered = false;
              this.hasOpenPosition = false;
              this.positionAmount = 0;
              this.entryPrice = 0;
              this.unrealizedPnl = 0;
              
              // 等待2秒确保订单取消完成
              log('等待2秒确保订单和持仓状态更新...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // 再次检查是否还有未取消的订单
              const remainingOrders = await this.tradingService.getOpenOrders(this.symbol);
              if (remainingOrders && remainingOrders.length > 0) {
                log(`发现${remainingOrders.length}个订单仍未被取消，暂不创建新订单`, true);
                return;
              }
              
              // 确认没有未取消订单后，创建新的订单序列
              log('平仓成功，开始创建新的订单序列...');
              await this.executeTrade();
              
              // 处理完止盈操作后直接返回，不执行后续逻辑
              return;
            }
          }
        } else {
          // 如果没有持仓，检查是否超过了无持仓等待时间
          const currentTime = Date.now();
          
          // 每隔设定的时间检查一次持仓状态
          if (currentTime - lastPositionCheckTime > noFillIntervalMs) {
            // 更新最后检查时间
            lastPositionCheckTime = currentTime;
            
            // 风险控制：如果无法获取持仓信息，不执行取消订单和创建新订单
            if (!this.canFetchPositions) {
              log('⚠️ 风险控制：无法获取持仓信息，暂不执行取消订单和创建新订单操作', true);
              return;
            }
            
            log(`已超过${noFillRestartMinutes}分钟无持仓，准备取消现有订单并重新下单`);
            
            // 双重确认持仓状态
            log('再次确认持仓状态...');
            await this.getPositionInfo();
            if (this.hasOpenPosition) {
              log('检测到持仓状态变化，中止订单操作', true);
              return;
            }
            
            // 记录平仓原因
            this.lastPositionClosedReason = `订单${noFillRestartMinutes}分钟未成交，取消重新下单`;
            
            // 取消现有未成交订单
            const cancelResult = await this.cancelOpenOrders();
            
            // 确保取消操作完成后才创建新订单
            if (cancelResult) {
              log(`订单取消成功，等待2秒后重新创建订单...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              // 再次检查是否还有未取消的订单
              const remainingOrders = await this.tradingService.getOpenOrders(this.symbol);
              if (remainingOrders && remainingOrders.length > 0) {
                log(`发现${remainingOrders.length}个订单仍未被取消，暂不创建新订单`, true);
                return;
              }
              
              // 确认没有未取消订单后，再执行交易策略
              await this.executeTrade();
              
              // 重置无持仓计时器
              lastPositionCheckTime = Date.now();
            } else {
              log(`订单取消失败，跳过重新下单操作`, true);
            }
          } else {
            // 计算剩余等待时间
            const remainingTimeMs = noFillIntervalMs - (currentTime - lastPositionCheckTime);
            const remainingMinutes = Math.floor(remainingTimeMs / 60000);
            const remainingSeconds = Math.floor((remainingTimeMs % 60000) / 1000);
            
            if (monitoringAttempts % 4 === 0) { // 每4次循环显示一次，避免日志过多
              log(`等待订单成交中，还有 ${remainingMinutes}分${remainingSeconds}秒 后检查无持仓状态`);
            }
          }
        }
        
      } catch (error) {
        log(`监控过程中发生错误: ${error.message}`, true);
      }
    }, this.config.advanced.monitorIntervalSeconds * 1000);
    
    return true;
  }

  /**
   * 平仓操作
   */
  async closePosition() {
    try {
      if (!this.hasOpenPosition) {
        log('没有持仓，无需平仓');
        return false;
      }
      
      log(`准备平仓: ${Math.abs(this.positionAmount)} ${this.tradingCoin}`);
      
      // 确定平仓方向 - 多仓平仓需要卖出，空仓平仓需要买入
      const side = this.positionSide === 'LONG' ? 'Sell' : 'Buy';
      
      // 创建市价平仓订单
      const orderData = {
        symbol: this.symbol,
        side: side,
        orderType: 'Market', // 市价单
        quantity: Math.abs(this.positionAmount),
        timeInForce: 'GTC'
      };
      
      const orderResult = await this.tradingService.createFuturesOrder(orderData);
      
      if (orderResult) {
        log(`平仓订单创建成功，订单ID: ${orderResult.orderId || orderResult.id || 'unknown'}`);
        log(`平仓价格: 市价`);
        log(`平仓数量: ${Math.abs(this.positionAmount)} ${this.tradingCoin}`);
        
        // 记录平仓原因
        if (this.lastPositionClosedReason) {
          log(`平仓原因: ${this.lastPositionClosedReason}`);
        } else {
          log(`平仓原因: 手动触发或系统默认平仓`);
        }
        
        return true;
      } else {
        log(`平仓订单未成功提交: ${JSON.stringify(orderResult || {})}`, true);
        return false;
      }
    } catch (error) {
      log(`平仓操作失败: ${error.message}`, true);
      if (error.response) {
        log(`API错误状态码: ${error.response.status}`, true);
        log(`API错误响应: ${JSON.stringify(error.response.data)}`, true);
      }
      return false;
    }
  }

  /**
   * 显示账户信息 - 重写父类方法以添加持仓信息
   */
  displayAccountInfo() {
    try {
      // 准备数据
      const timeNow = new Date().toLocaleString();
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      const elapsedTime = TimeUtils.getElapsedTime(this.scriptStartTime);
      
      // 价格信息
      let priceInfo = "等待WebSocket数据...";
      let priceChangeSymbol = "";
      let percentProgress = "0";
      
      // 获取当前的WebSocket连接状态
      let wsConnected = this.priceMonitor.isMonitoring();
      
      // 显示WebSocket连接状态及上次更新时间
      let wsStatusInfo = wsConnected ? "已连接" : "连接中...";
      
      // 如果有价格监控的上次更新时间，显示距离上次更新的时间
      if (this.priceMonitor.lastUpdateTime) {
        const lastUpdateTimeString = new Date(this.priceMonitor.lastUpdateTime).toLocaleTimeString();
        const dataAge = Math.floor((Date.now() - this.priceMonitor.lastUpdateTime) / 1000);
        wsStatusInfo += ` (${lastUpdateTimeString}, ${dataAge}秒前)`;
      }
      
      // 尝试所有可能的来源获取价格数据
      let priceFound = false;
      let currentPrice = 0;
      
      // 1. 首先尝试使用已有的价格信息
      if (this.currentPriceInfo && this.currentPriceInfo.price) {
        currentPrice = this.currentPriceInfo.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC`;
        
        // 如果有价格数据来源，显示来源
        if (this.currentPriceInfo.source) {
          priceInfo += ` (来源: ${this.currentPriceInfo.source})`;
        }
        
        priceFound = true;
      } 
      // 2. 如果没有价格信息，尝试从PriceMonitor获取
      else if (this.priceMonitor && this.priceMonitor.currentPrice > 0) {
        currentPrice = this.priceMonitor.currentPrice;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: 监控模块)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: '监控模块',
          updateTime: this.priceMonitor.lastUpdateTime || Date.now()
        };
        
        priceFound = true;
      } 
      // 3. 如果仍然没有价格，尝试从WebSocketManager直接获取
      else if (this.priceMonitor && this.priceMonitor.wsManager && 
               this.priceMonitor.wsManager.lastPriceData && 
               this.priceMonitor.wsManager.lastPriceData.price > 0) {
        
        const wsPrice = this.priceMonitor.wsManager.lastPriceData;
        currentPrice = wsPrice.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: WebSocket直接获取)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: 'WebSocket直接获取',
          updateTime: wsPrice.time || Date.now()
        };
        
        priceFound = true;
      }
      
      // 如果找到了价格数据并且有成交均价，计算涨跌幅和进度
      if (priceFound && this.tradeStats.filledOrders > 0 && this.tradeStats.averagePrice > 0) {
        // 计算涨跌幅
        const priceChange = ((currentPrice - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
        this.currentPriceInfo.increase = priceChange;
        
        const absChange = Math.abs(priceChange).toFixed(2);
        priceChangeSymbol = priceChange >= 0 ? "↑" : "↓";
        
        // 计算离止盈目标的进度百分比
        if (priceChange > 0 && takeProfitPercentage > 0) {
          percentProgress = this.tradingStrategy.calculateProgressPercentage(
            currentPrice, 
            this.tradeStats.averagePrice, 
            takeProfitPercentage
          ).toFixed(0);
        }
      } else {
        // 没有成交订单时重置涨跌幅显示
        priceChangeSymbol = "";
        percentProgress = "0";
        if (this.currentPriceInfo) {
          this.currentPriceInfo.increase = 0;
        }
      }
      
      // 计算订单相关的盈亏情况
      let orderCurrentValue = 0;
      let orderProfit = 0;
      let orderProfitPercent = 0;
      
      if (this.tradeStats.filledOrders > 0 && currentPrice > 0 && this.tradeStats.totalFilledQuantity > 0) {
        orderCurrentValue = currentPrice * this.tradeStats.totalFilledQuantity;
        orderProfit = orderCurrentValue - this.tradeStats.totalFilledAmount;
        orderProfitPercent = orderProfit / this.tradeStats.totalFilledAmount * 100;
      }
      
      // 准备持仓信息数据
      let positionInfo = null;
      if (this.hasOpenPosition && this.positionAmount && this.entryPrice) {
        positionInfo = {
          hasOpenPosition: this.hasOpenPosition,
          positionSide: this.positionSide,
          positionAmount: this.positionAmount,
          entryPrice: this.entryPrice,
          currentPrice: currentPrice,
          stopLossPrice: this.stopLossPrice,
          takeProfitPrice: this.takeProfitPrice
        };
        
        // 如果有有效价格，计算持仓总价值和盈亏
        if (currentPrice > 0) {
          const positionValue = currentPrice * Math.abs(this.positionAmount);
          const entryValue = this.entryPrice * Math.abs(this.positionAmount);
          const pnl = this.positionSide === 'LONG' 
            ? positionValue - entryValue 
            : entryValue - positionValue;
          const pnlPercentage = (pnl / entryValue) * 100;
          
          positionInfo.positionValue = positionValue;
          positionInfo.pnl = pnl;
          positionInfo.pnlPercentage = pnlPercentage;
        }
      }
      
      // 格式化并显示
      const data = {
        timeNow,
        symbol: this.symbol,
        scriptStartTime: this.scriptStartTime.toLocaleString(),
        elapsedTime,
        wsStatusInfo,
        priceInfo,
        priceChangeSymbol,
        increase: this.currentPriceInfo?.increase || 0,
        takeProfitPercentage,
        percentProgress,
        stats: this.tradeStats,
        tradingCoin: this.tradingCoin,
        currentValue: orderCurrentValue, 
        profit: orderProfit,
        profitPercent: orderProfitPercent,
        priceSource: this.currentPriceInfo?.source,
        // 添加持仓信息
        positionInfo: positionInfo
      };
      
      // 格式化并显示
      const display = Formatter.formatAccountInfo(data);
      console.clear();
      console.log(display);
      
      this.displayInitialized = true;
    } catch (error) {
      // 如果显示过程出错，回退到简单显示
      log(`显示信息时发生错误: ${error.message}`);
      // 简单显示函数
      console.log(`\n价格: ${this.currentPriceInfo?.price || '未知'} USDC`);
      console.log(`订单: ${this.tradeStats.filledOrders}/${this.tradeStats.totalOrders}`);
      if (this.hasOpenPosition) {
        console.log(`持仓: ${Math.abs(this.positionAmount)} ${this.tradingCoin} @ ${this.entryPrice} USDC`);
      }
      console.log(`错误: ${error.message}`);
    }
  }

  /**
   * 计算并设置止盈价格
   */
  calculateAndSetTakeProfitPrice() {
    try {
      if (!this.entryPrice || !this.positionAmount) {
        log('没有有效的持仓信息，无法计算止盈价格');
        return;
      }

      const takeProfitPercentage = this.config.futures?.takeProfitPercentage || 0.5;
      
      // 根据持仓方向计算止盈价格
      if (this.positionSide === 'LONG') {
        // 多仓止盈 = 入场价 * (1 + 止盈百分比/100)
        this.takeProfitPrice = this.entryPrice * (1 + takeProfitPercentage / 100);
      } else {
        // 空仓止盈 = 入场价 * (1 - 止盈百分比/100)
        this.takeProfitPrice = this.entryPrice * (1 - takeProfitPercentage / 100);
      }
      
      // 计算止损价格
      if (this.positionSide === 'LONG') {
        // 多仓止损 = 入场价 * (1 - 止损百分比/100)
        this.stopLossPrice = this.entryPrice * (1 - this.stopLossPercentage / 100);
      } else {
        // 空仓止损 = 入场价 * (1 + 止损百分比/100)
        this.stopLossPrice = this.entryPrice * (1 + this.stopLossPercentage / 100);
      }
      
      log(`入场价格: ${this.entryPrice} USDC`);
      log(`止盈价格: ${this.takeProfitPrice.toFixed(2)} USDC (${takeProfitPercentage}%)`);
      log(`止损价格: ${this.stopLossPrice.toFixed(2)} USDC (${this.stopLossPercentage}%)`);
      log(`注意：Backpack API不支持直接设置止损止盈，将使用价格监控实现`);
      
    } catch (error) {
      log(`计算止盈价格出错: ${error.message}`, true);
    }
  }

  /**
   * 检查止损条件是否触发
   * @param {number} currentPrice - 当前价格
   * @returns {boolean} 是否触发止损
   */
  isStopLossTriggered(currentPrice) {
    if (!this.hasOpenPosition || !this.stopLossPrice) return false;
    
    // 对于多仓，当价格低于止损价格时触发；对于空仓，当价格高于止损价格时触发
    if (this.positionSide === 'LONG') {
      if (currentPrice <= this.stopLossPrice) {
        // 记录平仓原因
        this.lastPositionClosedReason = `止损平仓 - 价格下跌至${currentPrice}，低于止损价${this.stopLossPrice}`;
        return true;
      }
    } else {
      if (currentPrice >= this.stopLossPrice) {
        // 记录平仓原因
        this.lastPositionClosedReason = `止损平仓 - 价格上涨至${currentPrice}，高于止损价${this.stopLossPrice}`;
        return true;
      }
    }
    
    return false;
  }
}

module.exports = FuturesTradingApp;