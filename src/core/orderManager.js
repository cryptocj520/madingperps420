const { OrderManager } = require('../models/Order');
const TradeStats = require('../models/TradeStats');
const BackpackService = require('../services/backpackService');
const { log } = require('../utils/logger');
const TimeUtils = require('../utils/timeUtils');
const Formatter = require('../utils/formatter');

/**
 * 订单管理器 - 管理交易订单的创建、取消和查询
 */
class OrderManagerService {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {BackpackService} backpackService - 交易API服务
   */
  constructor(config, backpackService) {
    this.config = config;
    this.backpackService = backpackService;
    this.orderManager = new OrderManager();
    this.tradeStats = new TradeStats();
    this.symbol = null;
    this.tradingCoin = null;
  }
  
  /**
   * 初始化订单管理器
   * @param {string} symbol - 交易对
   * @param {string} tradingCoin - 交易币种
   */
  initialize(symbol, tradingCoin) {
    this.symbol = symbol;
    this.tradingCoin = tradingCoin;
    this.orderManager.reset();
    this.tradeStats.reset();
    log(`订单管理器已初始化: ${this.symbol}`);
  }
  
  /**
   * 重置订单管理器状态
   */
  reset() {
    this.orderManager.reset();
    this.tradeStats.reset();
    log('订单管理器已重置');
  }
  
  /**
   * 创建买入订单
   * @param {Array} orders - 订单列表
   * @returns {Object} - 创建结果
   */
  async createBuyOrders(orders) {
    if (!this.symbol || !this.tradingCoin) {
      throw new Error('订单管理器尚未初始化');
    }
    
    // 显示计划创建的订单
    log('\n=== 计划创建的订单 ===');
    let totalOrderAmount = 0;
    orders.forEach((order, index) => {
      log(`订单 ${index + 1}: 价格=${order.price} USDC, 数量=${order.quantity} ${this.tradingCoin}, 金额=${order.amount.toFixed(2)} USDC`);
      totalOrderAmount += order.amount;
    });
    log(`总订单金额: ${totalOrderAmount.toFixed(2)} USDC`);
    
    // 重置统计信息以确保干净的数据
    this.tradeStats.reset();
    this.orderManager.reset();
    
    // 创建订单
    log('\n=== 开始创建订单 ===');
    let successCount = 0;
    
    // 保存计划创建的订单总数
    const plannedOrderCount = orders.length;
    
    // 创建订单循环
    let retryAttempts = 0;
    const MAX_RETRY_ATTEMPTS = 5;
    let createdOrdersCount = 0; // 跟踪实际创建的订单数量
    
    while (successCount < plannedOrderCount && retryAttempts < MAX_RETRY_ATTEMPTS) {
      // 如果是重试，展示重试信息
      if (retryAttempts > 0) {
        log(`\n===== 自动重试创建订单 (第 ${retryAttempts}/${MAX_RETRY_ATTEMPTS} 次) =====`);
        log(`已成功创建 ${successCount}/${plannedOrderCount} 个订单，继续尝试创建剩余订单...`);
      }
      
      // 只处理未成功创建的订单
      const remainingOrders = orders.slice(successCount);
      
      for (const order of remainingOrders) {
        try {
          // 检查是否已存在相同参数的订单
          if (this.orderManager.hasOrderSignature(order.getSignature())) {
            log(`跳过重复订单创建，价格=${order.price}, 数量=${order.quantity}`);
            continue;
          }
          
          // 创建买入订单
          const response = await this.backpackService.createBuyOrder(
            this.symbol, 
            order.price, 
            order.quantity, 
            this.tradingCoin
          );
          
          if (response && response.id) {
            // 设置订单ID
            order.id = response.id;
            order.status = response.status || 'New';
            
            // 添加到订单管理器
            this.orderManager.addOrder(order);
            
            successCount++;
            createdOrdersCount++;
            log(`成功创建第 ${successCount}/${plannedOrderCount} 个订单`);
            
            // 如果订单创建时已成交，更新统计信息
            if (order.status === 'Filled') {
              this.tradeStats.updateStats(order);
            }
            
            // 检查是否已创建足够数量的订单
            if (createdOrdersCount >= plannedOrderCount) {
              log(`已达到计划创建的订单数量: ${plannedOrderCount}`);
              break;
            }
            
            // 添加延迟避免API限制
            await TimeUtils.delay(3000);
          }
        } catch (error) {
          log(`创建订单失败: ${error.message}`, true);
          
          // 优先使用专门的API错误记录
          if (this.backpackService && this.backpackService.logger && 
              typeof this.backpackService.logger.logApiError === 'function') {
            this.backpackService.logger.logApiError(
              error, 
              "创建买入订单失败", 
              {
                symbol: this.symbol,
                price: order.price,
                quantity: order.quantity,
                side: 'Bid',
                orderType: 'Limit',
                timeInForce: 'GTC'
              }
            );
          } else {
            // 记录更详细的错误信息
            log(`创建订单失败详情:`, true);
            log(`- 订单: ${JSON.stringify({
              symbol: this.symbol,
              price: order.price,
              quantity: order.quantity,
              amount: order.amount,
              side: order.side,
              orderType: order.orderType,
              timeInForce: order.timeInForce
            })}`, true);
            
            // 记录错误对象详情
            if (error.response) {
              log(`- 响应状态: ${error.response.status}`, true);
              log(`- 响应数据: ${JSON.stringify(error.response.data || {})}`, true);
            }
            
            // 记录具体的订单
            log(`创建订单失败: ${error.message}, 订单: ${JSON.stringify(order)}`, true);
          }
          
          // 如果是资金不足，跳过后续订单
          if (error.message.includes('Insufficient') || error.message.includes('insufficient')) {
            log('资金不足，停止创建更多订单', true);
            break;
          } else {
            // 其他错误，等待后继续尝试
            const waitTime = Math.min(3000 * (retryAttempts + 1), 15000); // 随重试次数增加等待时间
            log(`等待${waitTime/1000}秒后自动重试...`);
            await TimeUtils.delay(waitTime);
          }
        }
      }
      
      // 如果所有订单都创建成功，跳出循环
      if (successCount >= plannedOrderCount) {
        log(`✓ 成功创建所有 ${plannedOrderCount} 个订单！`);
        break;
      }
      
      // 增加重试次数
      retryAttempts++;
      
      // 如果还未达到最大重试次数，自动继续尝试
      if (successCount < plannedOrderCount && retryAttempts < MAX_RETRY_ATTEMPTS) {
        // 添加随重试次数增加的等待时间
        const waitTime = 5000 * retryAttempts;
        log(`将在${waitTime/1000}秒后自动重试创建剩余订单...`);
        await TimeUtils.delay(waitTime);
      }
    }
    
    // 查询并更新订单状态
    await this.queryOrdersAndUpdateStats();
    
    return {
      success: successCount > 0,
      createdCount: successCount,
      plannedCount: plannedOrderCount,
      orders: this.orderManager.getAllOrders()
    };
  }
  
  /**
   * 卖出所有持仓
   * @param {Object} tradingStrategy - 交易策略实例
   * @returns {Object} - 卖出结果
   */
  async sellAllPosition(tradingStrategy) {
    try {
      // 获取当前持仓情况
      const position = await this.backpackService.getPosition(this.symbol);
      if (!position || parseFloat(position.quantity) <= 0) {
        log('没有可卖出的持仓');
        return null;
      }
      
      // 获取当前市场价格
      const ticker = await this.backpackService.getTicker(this.symbol);
      const currentPrice = parseFloat(ticker.lastPrice);
      
      // 设置卖出价格
      const sellPrice = tradingStrategy.calculateOptimalSellPrice(currentPrice, this.tradingCoin);
      const quantity = Formatter.adjustQuantityToStepSize(parseFloat(position.quantity), this.tradingCoin, this.config);
      
      log(`准备卖出: ${quantity} ${this.tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);
      
      // 创建卖出订单 - 修正参数顺序
      const response = await this.backpackService.createSellOrder(
        sellPrice,
        quantity,
        this.symbol
      );
      
      if (response && response.id) {
        log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
        
        // 检查订单是否完全成交
        let fullyFilled = response.status === 'Filled';
        
        // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
        if (!fullyFilled) {
          log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
          
          // 等待一小段时间，让订单有时间处理
          await TimeUtils.delay(2000);
          
          // 获取更新后的持仓
          const updatedPosition = await this.backpackService.getPosition(this.symbol);
          if (updatedPosition && parseFloat(updatedPosition.quantity) > 0) {
            const remainingQuantity = Formatter.adjustQuantityToStepSize(parseFloat(updatedPosition.quantity), this.tradingCoin, this.config);
            
            log(`仍有 ${remainingQuantity} ${this.tradingCoin} 未售出，尝试以更低价格卖出`);
            
            // 计算更低的卖出价格
            const lowerSellPrice = tradingStrategy.calculateSecondSellPrice(currentPrice, this.tradingCoin);
            
            // 创建第二次卖出订单 - 修正参数顺序
            const secondResponse = await this.backpackService.createSellOrder(
              lowerSellPrice,
              remainingQuantity,
              this.symbol
            );
            
            if (secondResponse && secondResponse.id) {
              log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
            }
          } else {
            log(`所有 ${this.tradingCoin} 已售出`);
          }
        }
        
        return response;
      } else {
        throw new Error('卖出订单创建失败：响应中没有订单ID');
      }
    } catch (error) {
      log(`卖出失败: ${error.message}`, true);
      return null;
    }
  }
  
  /**
   * 撤销所有未成交订单
   */
  async cancelAllOrders() {
    try {
      log(`开始撤销 ${this.symbol} 交易对的所有未完成订单...`);
      const result = await this.backpackService.cancelAllOrders(this.symbol);
      log(`撤销订单结果: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      log(`撤销订单失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 查询订单并更新统计
   */
  async queryOrdersAndUpdateStats() {
    try {
      log('查询当前交易周期新成交的订单...');
      
      // 获取当前未成交订单
      const openOrders = await this.backpackService.getOpenOrders(this.symbol);
      const currentOpenOrderIds = new Set(openOrders.map(order => order.id));
      
      // 遍历所有创建的订单，检查哪些已经不在未成交列表中
      const filledOrders = [];
      for (const orderId of this.orderManager.getAllCreatedOrderIds()) {
        if (!currentOpenOrderIds.has(orderId)) {
          const order = this.orderManager.getOrder(orderId);
          
          // 如果订单存在且未处理，则视为已成交
          if (order && !this.tradeStats.isOrderProcessed(orderId)) {
            order.status = 'Filled';
            filledOrders.push(order);
          }
        }
      }
      
      // 更新统计信息
      for (const order of filledOrders) {
        this.tradeStats.updateStats(order);
      }
      
      // 更新订单管理器中的待处理订单ID列表
      this.orderManager.updatePendingOrderIds(Array.from(currentOpenOrderIds));
      
      return filledOrders.length > 0;
    } catch (error) {
      log(`查询订单历史并更新统计失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 获取订单统计信息
   */
  getStats() {
    return this.tradeStats;
  }
  
  /**
   * 获取订单管理器
   */
  getOrderManager() {
    return this.orderManager;
  }
}

module.exports = OrderManagerService; 