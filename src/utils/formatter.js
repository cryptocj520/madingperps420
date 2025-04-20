/**
 * 格式化工具类 - 负责格式化数据以便显示或计算
 */
class Formatter {
  /**
   * 调整数值精度
   * @param {number} value - 需要调整的值
   * @param {number} precision - 精度（小数位数）
   * @returns {number} 调整后的值
   */
  static adjustPrecision(value, precision) {
    const multiplier = Math.pow(10, precision);
    return Math.floor(value * multiplier) / multiplier;
  }
  
  /**
   * 调整价格到tickSize，并根据交易对的精度要求进行处理
   * @param {number} price - 原始价格
   * @param {string} tradingCoin - 交易币种
   * @param {Object} config - 配置对象(可选)
   * @returns {number} 调整后的价格
   */
  static adjustPriceToTickSize(price, tradingCoin, config = {}) {
    // 设置默认值
    const tickSize = config?.advanced?.priceTickSize || 0.01;
    
    // 获取该币种的价格精度
    const pricePrecisions = config?.pricePrecisions || { 'BTC': 0, 'ETH': 2, 'SOL': 2, 'DEFAULT': 2 };
    const precision = pricePrecisions[tradingCoin] || pricePrecisions.DEFAULT || 2;
    
    // BTC特殊处理 - 确保价格是整数
    if (tradingCoin === 'BTC') {
      // 对BTC价格，直接向下取整到整数
      return Math.floor(price);
    }
    
    // 其他币种正常处理
    // 先向下取整到tickSize的倍数
    const adjustedPrice = Math.floor(price / tickSize) * tickSize;
    // 然后限制小数位数
    return Number(adjustedPrice.toFixed(precision));
  }
  
  /**
   * 调整数量到stepSize
   * @param {number} quantity - 原始数量
   * @param {string} tradingCoin - 交易币种
   * @param {Object} config - 配置对象(可选)
   * @returns {number} 调整后的数量
   */
  static adjustQuantityToStepSize(quantity, tradingCoin, config = {}) {
    // 设置默认值
    const quantityPrecisions = config?.quantityPrecisions || { 'BTC': 5, 'ETH': 4, 'SOL': 2, 'DEFAULT': 2 };
    const precision = quantityPrecisions[tradingCoin] || quantityPrecisions.DEFAULT || 2;
    
    const stepSize = Math.pow(10, -precision);
    const adjustedQuantity = Math.floor(quantity / stepSize) * stepSize;
    return Number(adjustedQuantity.toFixed(precision));
  }
  
  /**
   * 获取已运行时间的格式化字符串
   * @param {Date} startTime - 开始时间
   * @param {Date} endTime - 结束时间
   * @returns {string} 格式化的时间字符串
   */
  static getElapsedTimeString(startTime, endTime) {
    const elapsedMs = endTime - startTime;
    const seconds = Math.floor(elapsedMs / 1000) % 60;
    const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
    const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
    
    return `${hours}小时${minutes}分${seconds}秒`;
  }
  
  /**
   * 格式化账户信息显示
   * @param {Object} data - 账户数据
   * @returns {string} 格式化的账户信息文本
   */
  static formatAccountInfo(data) {
    const {
      timeNow,
      symbol,
      scriptStartTime,
      elapsedTime,
      wsStatusInfo,
      priceInfo,
      priceChangeSymbol,
      increase,
      takeProfitPercentage,
      percentProgress,
      stats,
      tradingCoin,
      currentValue,
      profit,
      profitPercent,
      priceSource,
      positionInfo
    } = data;
    
    let display = '===== Backpack 自动交易系统 =====\n';
    display += `当前时间: ${timeNow}\n`;
    display += `交易对: ${symbol}\n`;
    display += `脚本启动时间: ${scriptStartTime}\n`;
    display += `运行时间: ${elapsedTime}\n`;
    
    display += `\n===== 订单统计 =====\n`;
    // 添加WebSocket和价格信息到订单统计
    display += `WebSocket: ${wsStatusInfo}\n`;
    display += `当前价格: ${priceInfo}\n`;
    display += `涨跌幅: ${priceChangeSymbol} ${Math.abs(increase || 0).toFixed(2)}%\n`;
    display += `止盈目标: ${takeProfitPercentage}%\n`;
    display += `完成进度: ${percentProgress}%\n`;
    display += `总订单数: ${stats.totalOrders}\n`;
    display += `已成交订单: ${stats.filledOrders}\n`;
    display += `成交总金额: ${stats.totalFilledAmount.toFixed(2)} USDC\n`;
    display += `成交总数量: ${stats.totalFilledQuantity.toFixed(6)} ${tradingCoin}\n`;
    display += `平均成交价: ${stats.averagePrice.toFixed(2)} USDC\n`;
    
    // 显示盈亏情况
    if (stats.filledOrders > 0 && stats.totalFilledQuantity > 0) {
      const profitSymbol = profit >= 0 ? "↑" : "↓";
      
      display += `当前持仓价值: ${currentValue.toFixed(2)} USDC\n`;
      display += `盈亏金额: ${profitSymbol} ${Math.abs(profit).toFixed(2)} USDC\n`;
      display += `盈亏百分比: ${profitSymbol} ${Math.abs(profitPercent).toFixed(2)}%\n`;
    }
    
    // 显示当前持仓信息（如果有）
    if (positionInfo && positionInfo.hasOpenPosition) {
      display += `\n===== 当前持仓信息 =====\n`;
      display += `持仓方向: ${positionInfo.positionSide === 'LONG' ? '多仓' : '空仓'}\n`;
      display += `持仓数量: ${Math.abs(positionInfo.positionAmount)} ${tradingCoin}\n`;
      display += `入场价格: ${positionInfo.entryPrice.toFixed(2)} USDC\n`;
      
      if (positionInfo.currentPrice > 0) {
        display += `当前价格: ${positionInfo.currentPrice.toFixed(2)} USDC\n`;
        display += `持仓总价值: ${positionInfo.positionValue.toFixed(2)} USDC\n`;
        
        const pnlSymbol = positionInfo.pnl >= 0 ? "↑" : "↓";
        display += `未实现盈亏: ${pnlSymbol} ${Math.abs(positionInfo.pnl).toFixed(2)} USDC (${pnlSymbol} ${Math.abs(positionInfo.pnlPercentage).toFixed(2)}%)\n`;
        
        if (positionInfo.stopLossPrice > 0) {
          display += `止损价格: ${positionInfo.stopLossPrice.toFixed(2)} USDC\n`;
        }
        
        if (positionInfo.takeProfitPrice > 0) {
          display += `止盈价格: ${positionInfo.takeProfitPrice.toFixed(2)} USDC\n`;
        }
      }
    }
    
    display += `最后更新: ${new Date().toLocaleString()}\n`;
    
    return display;
  }
}

module.exports = Formatter; 