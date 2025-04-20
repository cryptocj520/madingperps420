const Formatter = require('../utils/formatter');
const { log } = require('../utils/logger');
const { Order } = require('../models/Order');

/**
 * 交易策略类 - 负责计算交易策略和订单
 */
class TradingStrategy {
  /**
   * 构造函数
   * @param {Object} logger - 日志对象
   * @param {Object} config - 配置对象(可选)
   */
  constructor(logger, config = {}) {
    this.logger = logger;
    this.config = config;
  }
  
  /**
   * 计算递增订单
   * @param {number} currentPrice - 当前市场价格
   * @param {number} maxDropPercentage - 最大跌幅百分比
   * @param {number} totalAmount - 总投资金额
   * @param {number} orderCount - 订单数量
   * @param {number} incrementPercentage - 递增百分比
   * @param {number} minOrderAmount - 最小订单金额
   * @param {string} tradingCoin - 交易币种
   * @param {string} symbol - 交易对符号
   * @returns {Array<Order>} 订单列表
   */
  calculateIncrementalOrders(
    currentPrice,
    maxDropPercentage,
    totalAmount,
    orderCount,
    incrementPercentage,
    minOrderAmount,
    tradingCoin,
    symbol
  ) {
    const orders = [];
    
    // 计算价格区间
    const lowestPrice = currentPrice * (1 - maxDropPercentage / 100);
    const priceStep = (currentPrice - lowestPrice) / (orderCount - 1);
    
    // 计算基础订单金额（使用等比数列求和公式）
    // 总金额 = 基础金额 * (1 + r + r^2 + ... + r^(n-1))
    // 总金额 = 基础金额 * (1 - r^n) / (1 - r)
    // 基础金额 = 总金额 * (1 - r) / (1 - r^n)
    const r = 1 + incrementPercentage / 100; // 递增比例
    
    // 确保基础订单金额不小于最小订单金额
    const calculatedBaseAmount = totalAmount * (r - 1) / (Math.pow(r, orderCount) - 1);
    const baseAmount = Math.max(minOrderAmount, calculatedBaseAmount);
    
    // 计算实际总金额
    let actualTotalAmount = 0;
    for (let i = 0; i < orderCount; i++) {
      actualTotalAmount += baseAmount * Math.pow(r, i);
    }
    
    // 处理实际总金额超过用户输入的总金额的情况
    const orderAmounts = [];
    const scale = actualTotalAmount > totalAmount ? totalAmount / actualTotalAmount : 1;
    
    // 创建订单
    for (let i = 0; i < orderCount; i++) {
      // 计算当前订单价格
      const rawPrice = currentPrice - (priceStep * i);
      // 调整价格到交易所接受的格式
      const price = Formatter.adjustPriceToTickSize(rawPrice, tradingCoin, this.config);
      
      // 计算当前订单金额（递增并缩放）
      const orderAmount = baseAmount * Math.pow(r, i) * scale;
      
      // 计算数量并调整精度
      const quantity = Formatter.adjustQuantityToStepSize(orderAmount / price, tradingCoin, this.config);
      const actualAmount = price * quantity;
      
      // 只有当订单金额满足最小要求时才添加
      if (actualAmount >= minOrderAmount) {
        const orderData = {
          symbol,
          price,
          quantity,
          amount: actualAmount,
          side: 'Bid',
          orderType: 'Limit',
          timeInForce: 'GTC'
        };
        
        const order = new Order(orderData);
        orders.push(order);
        
        orderAmounts.push(actualAmount);
      }
    }
    
    // 如果没有生成任何订单，抛出错误
    if (orders.length === 0) {
      throw new Error('无法生成有效订单，请检查输入参数');
    }
    
    // 计算实际总金额
    const finalTotalAmount = orderAmounts.reduce((sum, amount) => sum + amount, 0);
    
    log(`计划总金额: ${totalAmount.toFixed(2)} USDC`);
    log(`实际总金额: ${finalTotalAmount.toFixed(2)} USDC`);
    
    return orders;
  }
  
  /**
   * 检查是否达到止盈条件
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {boolean} 是否达到止盈条件
   */
  isTakeProfitTriggered(currentPrice, averagePrice, takeProfitPercentage) {
    if (!currentPrice || !averagePrice || averagePrice <= 0) {
      return false;
    }
    
    // 计算价格涨幅百分比
    const priceIncrease = ((currentPrice - averagePrice) / averagePrice) * 100;
    
    // 判断是否达到止盈条件
    return priceIncrease >= takeProfitPercentage;
  }
  
  /**
   * 计算最优卖出价格
   * @param {number} currentPrice - 当前市场价格
   * @param {string} tradingCoin - 交易币种
   * @returns {number} 最优卖出价格
   */
  calculateOptimalSellPrice(currentPrice, tradingCoin) {
    // 设置卖出价格略低于市场价（确保能够成交）
    return Formatter.adjustPriceToTickSize(currentPrice * 0.995, tradingCoin, this.config);
  }
  
  /**
   * 计算第二次卖出价格（更低）
   * @param {number} currentPrice - 当前市场价格
   * @param {string} tradingCoin - 交易币种
   * @returns {number} 二次卖出价格
   */
  calculateSecondSellPrice(currentPrice, tradingCoin) {
    // 使用更低的价格进行二次尝试（原价格的99%）
    return Formatter.adjustPriceToTickSize(currentPrice * 0.99, tradingCoin, this.config);
  }
  
  /**
   * 计算进度百分比
   * @param {number} currentPrice - 当前价格
   * @param {number} averagePrice - 平均买入价格
   * @param {number} takeProfitPercentage - 止盈百分比
   * @returns {number} 完成进度百分比
   */
  calculateProgressPercentage(currentPrice, averagePrice, takeProfitPercentage) {
    if (!currentPrice || !averagePrice || averagePrice <= 0 || takeProfitPercentage <= 0) {
      return 0;
    }
    
    // 计算价格涨幅百分比
    const priceIncrease = ((currentPrice - averagePrice) / averagePrice) * 100;
    
    // 计算进度百分比，限制在0-100之间
    return Math.min(100, Math.max(0, (priceIncrease / takeProfitPercentage * 100)));
  }
}

module.exports = TradingStrategy; 