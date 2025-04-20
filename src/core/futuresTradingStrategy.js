const TradingStrategy = require('./tradingStrategy');
const Formatter = require('../utils/formatter');
const { log } = require('../utils/logger');
const { Order } = require('../models/Order');

/**
 * 合约交易策略类 - 扩展自基础交易策略，添加合约特有功能
 */
class FuturesTradingStrategy extends TradingStrategy {
  /**
   * 构造函数
   * @param {Object} logger - 日志对象
   * @param {Object} config - 配置对象
   */
  constructor(logger, config = {}) {
    super(logger, config);
    this.positionSide = config.futures?.positionSide || 'LONG';
    this.leverage = config.futures?.leverage || 1;
    this.riskManagement = config.riskManagement || {};
  }
  
  /**
   * 计算合约递增订单
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
  calculateFuturesOrders(
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
    
    // 计算合约订单，考虑杠杆因素
    const leveragedTotalAmount = totalAmount * this.leverage;
    
    // 使用父类方法计算基本订单结构
    let orders;
    if (isLong) {
      orders = super.calculateIncrementalOrders(
        currentPrice,
        maxDropPercentage,
        leveragedTotalAmount,
        orderCount,
        incrementPercentage,
        minOrderAmount,
        tradingCoin,
        symbol
      );
    } else {
      // 为做空策略创建特殊的订单结构
      orders = this.calculateShortOrders(
        currentPrice,
        maxDropPercentage,
        leveragedTotalAmount,
        orderCount,
        incrementPercentage,
        minOrderAmount,
        tradingCoin,
        symbol
      );
    }
    
    // 为每个订单添加合约特有的属性
    orders.forEach(order => {
      order.positionSide = this.positionSide;
      order.leverage = this.leverage;
      
      // 处理做空订单的side属性
      if (!isLong) {
        order.side = 'Ask'; // 卖出做空
      }
    });
    
    return orders;
  }
  
  /**
   * 计算做空订单序列
   * @param {number} currentPrice - 当前市场价格
   * @param {number} maxRisePercentage - 最大涨幅百分比
   * @param {number} totalAmount - 总投资金额
   * @param {number} orderCount - 订单数量
   * @param {number} incrementPercentage - 递增百分比
   * @param {number} minOrderAmount - 最小订单金额
   * @param {string} tradingCoin - 交易币种
   * @param {string} symbol - 交易对符号
   * @returns {Array<Order>} 订单列表
   */
  calculateShortOrders(
    currentPrice,
    maxRisePercentage,
    totalAmount,
    orderCount,
    incrementPercentage,
    minOrderAmount,
    tradingCoin,
    symbol
  ) {
    const orders = [];
    
    // 计算价格区间
    const highestPrice = currentPrice * (1 + maxRisePercentage / 100);
    const priceStep = (highestPrice - currentPrice) / (orderCount - 1);
    
    // 计算基础订单金额
    const r = 1 + incrementPercentage / 100; // 递增比例
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
      // 计算当前订单价格 - 做空时价格上升
      const rawPrice = currentPrice + (priceStep * i);
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
          side: 'Ask', // 做空
          orderType: 'Limit',
          timeInForce: 'GTC',
          positionSide: 'SHORT'
        };
        
        const order = new Order(orderData);
        orders.push(order);
        
        orderAmounts.push(actualAmount);
      }
    }
    
    // 计算实际总金额
    const finalTotalAmount = orderAmounts.reduce((sum, amount) => sum + amount, 0);
    
    log(`计划总金额(含杠杆): ${totalAmount.toFixed(2)} USDC`);
    log(`实际总金额(含杠杆): ${finalTotalAmount.toFixed(2)} USDC`);
    
    return orders;
  }
  
  /**
   * 计算止损价格
   * @param {number} entryPrice - 入场价格
   * @param {boolean} isLong - 是否做多
   * @returns {number} 止损价格
   */
  calculateStopLossPrice(entryPrice, isLong = this.positionSide === 'LONG') {
    const stopLossPercentage = this.riskManagement.stopLossPercentage || 3;
    
    if (isLong) {
      // 做多止损 - 价格下跌到一定百分比
      return entryPrice * (1 - stopLossPercentage / 100);
    } else {
      // 做空止损 - 价格上涨到一定百分比
      return entryPrice * (1 + stopLossPercentage / 100);
    }
  }
  
  /**
   * 计算止盈价格
   * @param {number} entryPrice - 入场价格
   * @param {boolean} isLong - 是否做多
   * @returns {number} 止盈价格
   */
  calculateTakeProfitPrice(entryPrice, isLong = this.positionSide === 'LONG') {
    const takeProfitPercentage = this.config.futures?.takeProfitPercentage || 0.4;
    
    if (isLong) {
      // 做多止盈 - 价格上涨到一定百分比
      return entryPrice * (1 + takeProfitPercentage / 100);
    } else {
      // 做空止盈 - 价格下跌到一定百分比
      return entryPrice * (1 - takeProfitPercentage / 100);
    }
  }
  
  /**
   * 计算动态止损价格 (跟踪止损)
   * @param {number} entryPrice - 入场价格
   * @param {number} currentPrice - 当前价格
   * @param {boolean} isLong - 是否做多
   * @returns {number|null} 更新的止损价格，如果不需更新则返回null
   */
  calculateDynamicStopLoss(entryPrice, currentPrice, isLong = this.positionSide === 'LONG') {
    if (!this.riskManagement.dynamicStopLoss) {
      return null;
    }
    
    const activationPercentage = this.riskManagement.trailingStopActivation || 1;
    const trailingDistance = this.riskManagement.trailingStopDistance || 0.5;
    
    if (isLong) {
      // 做多动态止损
      // 检查是否达到激活条件 (价格上涨X%)
      const priceIncrease = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      if (priceIncrease >= activationPercentage) {
        // 动态止损 = 当前价格 * (1 - 跟踪距离%)
        return currentPrice * (1 - trailingDistance / 100);
      }
    } else {
      // 做空动态止损
      // 检查是否达到激活条件 (价格下跌X%)
      const priceDecrease = ((entryPrice - currentPrice) / entryPrice) * 100;
      
      if (priceDecrease >= activationPercentage) {
        // 动态止损 = 当前价格 * (1 + 跟踪距离%)
        return currentPrice * (1 + trailingDistance / 100);
      }
    }
    
    return null;
  }
  
  /**
   * 检查是否触发止盈条件
   * @param {number} currentPrice - 当前价格
   * @param {number} entryPrice - 入场价格(或平均买入价格)
   * @param {number} takeProfitPercentage - 止盈百分比
   * @param {boolean} isLong - 是否做多
   * @returns {boolean} 是否达到止盈条件
   */
  isFuturesTakeProfitTriggered(
    currentPrice, 
    entryPrice, 
    takeProfitPercentage,
    isLong = this.positionSide === 'LONG'
  ) {
    if (!currentPrice || !entryPrice || entryPrice <= 0) {
      return false;
    }
    
    if (isLong) {
      // 做多止盈条件
      const priceIncrease = ((currentPrice - entryPrice) / entryPrice) * 100;
      return priceIncrease >= takeProfitPercentage;
    } else {
      // 做空止盈条件
      const priceDecrease = ((entryPrice - currentPrice) / entryPrice) * 100;
      return priceDecrease >= takeProfitPercentage;
    }
  }
  
  /**
   * 检查是否触发止损条件
   * @param {number} currentPrice - 当前价格
   * @param {number} stopLossPrice - 止损价格
   * @param {boolean} isLong - 是否做多
   * @returns {boolean} 是否达到止损条件
   */
  isStopLossTriggered(currentPrice, stopLossPrice, isLong = this.positionSide === 'LONG') {
    if (!currentPrice || !stopLossPrice || stopLossPrice <= 0) {
      return false;
    }
    
    if (isLong) {
      // 做多止损触发条件 - 当前价格低于止损价
      return currentPrice <= stopLossPrice;
    } else {
      // 做空止损触发条件 - 当前价格高于止损价
      return currentPrice >= stopLossPrice;
    }
  }
  
  /**
   * 计算持仓盈亏百分比
   * @param {number} currentPrice - 当前价格
   * @param {number} entryPrice - 入场价格
   * @param {boolean} isLong - 是否做多
   * @returns {number} 盈亏百分比
   */
  calculateProfitPercentage(currentPrice, entryPrice, isLong = this.positionSide === 'LONG') {
    if (!currentPrice || !entryPrice || entryPrice <= 0) {
      return 0;
    }
    
    if (isLong) {
      // 做多盈亏
      return ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      // 做空盈亏
      return ((entryPrice - currentPrice) / entryPrice) * 100;
    }
  }
  
  /**
   * 计算考虑杠杆后的实际盈亏百分比
   * @param {number} currentPrice - 当前价格
   * @param {number} entryPrice - 入场价格
   * @param {number} leverage - 杠杆倍数
   * @param {boolean} isLong - 是否做多
   * @returns {number} 含杠杆的盈亏百分比
   */
  calculateLeveragedProfitPercentage(
    currentPrice, 
    entryPrice, 
    leverage = this.leverage,
    isLong = this.positionSide === 'LONG'
  ) {
    const baseProfit = this.calculateProfitPercentage(currentPrice, entryPrice, isLong);
    return baseProfit * leverage;
  }
  
  /**
   * 检查资金费率是否在可接受范围内
   * @param {number} fundingRate - 当前资金费率(百分比)
   * @returns {boolean} 资金费率是否可接受
   */
  isFundingRateAcceptable(fundingRate) {
    const limit = this.config.advanced?.fundingRateLimit || 0.001;
    
    // 对于做多，负的资金费率是有利的
    // 对于做空，正的资金费率是有利的
    if (this.positionSide === 'LONG') {
      return fundingRate <= limit;
    } else {
      return fundingRate >= -limit;
    }
  }
  
  /**
   * 评估风险并返回交易决策
   * @param {number} currentPrice - 当前价格
   * @param {Object} position - 当前持仓信息
   * @param {Object} accountInfo - 账户信息
   * @returns {Object} 风险评估结果
   */
  evaluateRisk(currentPrice, position, accountInfo) {
    const maxDrawdown = this.riskManagement.maxDrawdownPercentage || 15;
    const maxRisk = this.config.advanced?.maxPositionRisk || 0.2;
    
    let riskLevel = 'LOW';
    let action = 'CONTINUE';
    const reasons = [];
    
    // 检查盈亏情况
    if (position && position.entryPrice) {
      const profitPercent = this.calculateLeveragedProfitPercentage(
        currentPrice, 
        position.entryPrice
      );
      
      if (profitPercent <= -maxDrawdown) {
        riskLevel = 'EXTREME';
        action = 'CLOSE_POSITION';
        reasons.push(`亏损超过最大回撤: ${profitPercent.toFixed(2)}% <= -${maxDrawdown}%`);
      } else if (profitPercent <= -maxDrawdown * 0.8) {
        riskLevel = 'HIGH';
        action = 'REDUCE_POSITION';
        reasons.push(`亏损接近最大回撤: ${profitPercent.toFixed(2)}%`);
      }
    }
    
    // 检查仓位风险
    if (position && accountInfo) {
      const positionValue = position.positionAmount || 0;
      const accountValue = accountInfo.totalMarginBalance || 0;
      
      if (accountValue > 0) {
        const riskRatio = positionValue / accountValue;
        
        if (riskRatio > maxRisk) {
          riskLevel = Math.max(riskLevel, 'HIGH');
          action = action === 'CONTINUE' ? 'REDUCE_POSITION' : action;
          reasons.push(`仓位风险过高: ${(riskRatio * 100).toFixed(2)}% > ${maxRisk * 100}%`);
        }
      }
    }
    
    // 检查杠杆是否过高
    const maxLeverage = this.riskManagement.maxLeverage || 10;
    if (this.leverage > maxLeverage) {
      riskLevel = Math.max(riskLevel, 'MEDIUM');
      reasons.push(`杠杆较高: ${this.leverage}x > 推荐的${maxLeverage}x`);
    }
    
    return {
      riskLevel,
      action,
      reasons,
      timestamp: new Date()
    };
  }
}

module.exports = FuturesTradingStrategy; 