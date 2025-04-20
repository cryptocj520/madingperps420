/**
 * 交易统计类 - 负责管理和计算交易统计数据
 */
// 导入日志工具
const { log } = require('../utils/logger');

class TradeStats {
  /**
   * 构造函数 - 初始化统计数据
   */
  constructor() {
    this.reset();
  }
  
  /**
   * 重置所有统计数据
   */
  reset() {
    this.totalOrders = 0;
    this.filledOrders = 0;
    this.totalFilledAmount = 0;
    this.totalFilledQuantity = 0;
    this.averagePrice = 0;
    this.lastUpdateTime = null;
    
    // 确保完全清空处理过的订单ID集合
    if (this.processedOrderIds) {
      this.processedOrderIds.clear();
    } else {
      this.processedOrderIds = new Set();
    }
    
    // 输出重置确认日志
    if (typeof log === 'function') {
      log('交易统计数据已完全重置');
    }
  }
  
  /**
   * 更新统计信息
   * @param {Object} order - 订单信息
   * @returns {boolean} 是否已更新数据
   */
  updateStats(order) {
    if (!order || !order.id) return false;
    
    // 检查订单ID是否已处理过
    if (this.processedOrderIds.has(order.id)) {
      // 使用全局log函数（如果可用）记录已处理订单的情况
      if (typeof log === 'function') {
        log(`跳过已处理订单ID: ${order.id}`);
      }
      return false;
    }
    
    // 不再在这里增加totalOrders计数，因为订单创建时已经增加
    // 避免重复计数问题
    
    // 确保有成交信息再更新成交统计
    if (order.status === 'Filled' || order.status === 'PartiallyFilled') {
      // 确保使用数字类型进行计算
      const filledAmount = parseFloat(order.filledAmount || (order.price * order.quantity) || 0);
      const filledQuantity = parseFloat(order.filledQuantity || order.quantity || 0);
      const price = parseFloat(order.price || 0);
      
      // 检查数据有效性
      if (isNaN(filledAmount) || isNaN(filledQuantity) || isNaN(price)) {
        if (typeof log === 'function') {
          log(`订单${order.id}包含无效数据: 数量=${filledQuantity}, 金额=${filledAmount}, 价格=${price}`, true);
        }
        return false;
      }
      
      // 检查数据合理性
      if (filledAmount <= 0 || filledQuantity <= 0 || price <= 0) {
        if (typeof log === 'function') {
          log(`订单${order.id}数据不合理: 数量=${filledQuantity}, 金额=${filledAmount}, 价格=${price}`, true);
        }
        return false;
      }
      
      // 添加到已处理订单集合
      this.processedOrderIds.add(order.id);
      
      // 记录处理详情（如果log函数可用）
      if (typeof log === 'function') {
        log(`处理订单ID: ${order.id}, 状态: ${order.status}, 数量: ${filledQuantity}, 金额: ${filledAmount}`);
      }
      
      // 更新统计数据
      this.totalFilledAmount += filledAmount;
      this.totalFilledQuantity += filledQuantity;
      this.filledOrders++;
      
      // 记录已成交订单计数增加（如果log函数可用）
      if (typeof log === 'function') {
        log(`成交订单数增加到: ${this.filledOrders}, 订单ID: ${order.id}`);
      }
      
      // 只有当有效成交量存在时才计算均价
      if (this.totalFilledQuantity > 0) {
        this.averagePrice = this.totalFilledAmount / this.totalFilledQuantity;
        
        // 记录均价更新（如果log函数可用）
        if (typeof log === 'function') {
          log(`均价更新为: ${this.averagePrice.toFixed(2)}, 总成交量: ${this.totalFilledQuantity.toFixed(6)}`);
        }
      }
      
      this.lastUpdateTime = new Date();
      return true;
    } else {
      // 非成交状态订单（如果log函数可用）
      if (typeof log === 'function') {
        log(`订单${order.id}非成交状态: ${order.status}, 不更新成交统计`);
      }
    }
    
    return false;
  }
  
  /**
   * 计算当前盈亏情况
   * @param {number} currentPrice - 当前市场价格
   * @returns {Object|null} 盈亏信息对象，包含金额和百分比
   */
  calculateProfit(currentPrice) {
    if (this.filledOrders === 0 || this.totalFilledQuantity <= 0 || !currentPrice) {
      return null;
    }
    
    const currentValue = currentPrice * this.totalFilledQuantity;
    const profit = currentValue - this.totalFilledAmount;
    const profitPercent = profit / this.totalFilledAmount * 100;
    
    return {
      currentValue,
      profit,
      profitPercent
    };
  }
  
  /**
   * 获取统计摘要
   * @returns {Object} 统计摘要对象
   */
  getSummary() {
    return {
      totalOrders: this.totalOrders,
      filledOrders: this.filledOrders,
      totalFilledAmount: this.totalFilledAmount,
      totalFilledQuantity: this.totalFilledQuantity,
      averagePrice: this.averagePrice,
      lastUpdateTime: this.lastUpdateTime,
      processedOrdersCount: this.processedOrderIds.size
    };
  }
  
  /**
   * 添加已处理订单ID
   * @param {string} orderId - 订单ID
   */
  addProcessedOrderId(orderId) {
    if (orderId) {
      this.processedOrderIds.add(orderId);
    }
  }
  
  /**
   * 检查订单ID是否已处理
   * @param {string} orderId - 订单ID
   * @returns {boolean} 是否已处理
   */
  isOrderProcessed(orderId) {
    return this.processedOrderIds.has(orderId);
  }
}

module.exports = TradeStats; 