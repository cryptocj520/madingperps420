const fs = require('fs');
const path = require('path');

/**
 * 配置加载器类 - 负责加载和验证配置
 */
class ConfigLoader {
  /**
   * 加载配置文件
   * @param {string} configPath - 配置文件路径，默认为当前工作目录下的backpack_trading_config.json
   * @returns {Object} 配置对象
   */
  static loadConfig(configPath = path.join(process.cwd(), 'backpack_trading_config.json')) {
    try {
      console.log(`加载配置文件: ${configPath}`);
      
      if (!fs.existsSync(configPath)) {
        throw new Error(`配置文件不存在: ${configPath}`);
      }
      
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      
      // 验证配置
      this.validateConfig(config);
      
      console.log(`配置文件加载成功`);
      return config;
    } catch (error) {
      console.error(`加载配置文件失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 验证配置有效性
   * @param {Object} config - 配置对象
   * @throws {Error} 如果配置无效
   */
  static validateConfig(config) {
    // 验证API配置
    if (!config.api) {
      throw new Error('缺少API配置');
    }
    if (!config.api.privateKey) {
      throw new Error('缺少API私钥配置');
    }
    if (!config.api.publicKey) {
      throw new Error('缺少API公钥配置');
    }
    
    // 验证交易配置
    if (!config.trading) {
      throw new Error('缺少交易配置');
    }
    if (!config.trading.tradingCoin) {
      throw new Error('缺少交易币种配置');
    }
    if (!config.trading.totalAmount) {
      throw new Error('缺少总金额配置');
    }
    if (!config.trading.orderCount) {
      throw new Error('缺少订单数量配置');
    }
    if (!config.trading.maxDropPercentage) {
      throw new Error('缺少最大下跌百分比配置');
    }
    if (!config.trading.incrementPercentage) {
      throw new Error('缺少增量百分比配置');
    }
    if (!config.trading.takeProfitPercentage) {
      throw new Error('缺少止盈百分比配置');
    }
    
    // 验证精度配置
    if (!config.minQuantities) {
      throw new Error('缺少最小数量配置');
    }
    if (!config.quantityPrecisions) {
      throw new Error('缺少数量精度配置');
    }
    if (!config.pricePrecisions) {
      throw new Error('缺少价格精度配置');
    }
    
    // 验证动作配置
    if (!config.actions) {
      config.actions = {
        sellNonUsdcAssets: false,
        cancelAllOrders: true,
        restartAfterTakeProfit: false,
        autoRestartNoFill: false,
        executeTrade: true,
        cancelOrdersOnExit: true
      };
    } else {
      // 确保新版本中的字段存在
      if (config.actions.executeTrade === undefined) {
        config.actions.executeTrade = true;
      }
      if (config.actions.cancelOrdersOnExit === undefined) {
        config.actions.cancelOrdersOnExit = true;
      }
    }
    
    // 验证高级配置
    if (!config.advanced) {
      config.advanced = {
        minOrderAmount: 10,
        priceTickSize: 0.01,
        checkOrdersIntervalMinutes: 5,
        monitorIntervalSeconds: 15,
        sellNonUsdcMinValue: 10,
        noFillRestartMinutes: 60
      };
    }
    
    // 验证websocket配置
    if (!config.websocket) {
      config.websocket = {
        url: 'wss://ws.backpack.exchange'
      };
    }
  }
}

module.exports = ConfigLoader; 