const { BackpackClient } = require('../../backpack_exchange-main/backpack_client');
const { log } = require('../utils/logger');
const TimeUtils = require('../utils/timeUtils');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Backpack交易所API服务类 - 负责处理API调用
 */
class BackpackService {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {Object} logger - 日志对象
   */
  constructor(config, logger) {
    this.config = config;
    // 确保logger对象始终存在，防止访问undefined的属性
    this.logger = logger || defaultLogger || console;
    this.privateKey = config.api.privateKey;
    this.publicKey = config.api.publicKey;
    this.tradingCoin = config.trading?.tradingCoin || 'BTC';
    this.symbol = `${this.tradingCoin}_USDC`; 
    
    // 初始化官方BackpackClient
    try {
      this.client = new BackpackClient(this.privateKey, this.publicKey);
    } catch (error) {
      // 如果初始化失败，记录错误并尝试继续
      if (this.logger && typeof this.logger.log === 'function') {
        this.logger.log(`初始化BackpackClient失败: ${error.message}`, true);
      } else {
        console.error(`初始化BackpackClient失败: ${error.message}`);
      }
    }
  }
  
  /**
   * 执行API请求，自动处理重试逻辑
   * @param {Function} apiCall - API调用函数
   * @param {number} maxRetries - 最大重试次数
   * @param {number} initialRetryDelay - 初始重试间隔(毫秒)
   * @returns {Promise<any>} - API响应
   */
  async executeWithRetry(apiCall, maxRetries = 3, initialRetryDelay = 5000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        lastError = error;
        
        // 构建详细的错误日志
        let errorMessage = `API调用失败(尝试 ${attempt}/${maxRetries}): ${error.message}`;
        
        // 记录日志到logger或console
        if (this.logger && typeof this.logger.log === 'function') {
          this.logger.log(errorMessage, true);
          
          // 记录更多细节信息
          if (error.response) {
            const statusCode = error.response.status || 'unknown';
            const responseBody = JSON.stringify(error.response.data || {});
            this.logger.log(`响应代码 ${statusCode} (${error.response.statusText || 'No status text'})`, true);
            this.logger.log(`响应体: ${responseBody}`, true);
            
            // 尝试提取更具体的错误信息
            if (error.response.data) {
              const data = error.response.data;
              if (data.message) {
                this.logger.log(`错误消息: ${data.message}`, true);
              }
              if (data.code) {
                this.logger.log(`错误代码: ${data.code}`, true);
              }
              if (data.error) {
                this.logger.log(`错误详情: ${JSON.stringify(data.error)}`, true);
              }
            }
          }
          
          // 记录请求信息(如果有)
          if (error.request) {
            this.logger.log(`请求方法: ${error.request.method}`, true);
            this.logger.log(`请求URL: ${error.request.path}`, true);
          }
        } else {
          console.log(errorMessage);
          if (error.response) {
            console.log(`响应状态: ${error.response.status}`);
            console.log(`响应数据: ${JSON.stringify(error.response.data || {})}`);
          }
        }
        
        if (attempt < maxRetries) {
          // 使用指数退避计算重试延迟
          const retryDelay = Math.min(
            60000, // 最长延迟60秒
            initialRetryDelay * Math.pow(2, attempt - 1)
          );
          
          const logMethod = this.logger?.log || console.log;
          logMethod(`将在 ${retryDelay/1000} 秒后重试 (尝试 ${attempt+1}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * 获取行情数据
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 行情数据
   */
  async getTicker(symbol = this.symbol) {
    try {
      // 记录API调用详情，用于调试
      this.logger?.log(`获取${symbol}行情数据...`);
      
      const result = await this.executeWithRetry(() => 
        this.client.Ticker({ symbol })
      );
      
      // 记录接收到的数据
      if (result) {
        this.logger?.log(`获取到${symbol}行情: 最新价=${result.lastPrice}`);
      } else {
        this.logger?.log(`获取${symbol}行情响应数据为空`);
      }
      
      return result;
    } catch (error) {
      this.logger?.log(`获取行情失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 获取账户余额
   * @returns {Promise<Object>} 账户余额
   */
  async getBalances() {
    try {
      return await this.executeWithRetry(() => 
        this.client.Balance()
      );
    } catch (error) {
      this.logger?.log(`获取余额失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 获取所有未成交订单
   * @param {string} symbol - 交易对
   * @returns {Promise<Array>} 未成交订单列表
   */
  async getOpenOrders(symbol = this.symbol) {
    try {
      return await this.executeWithRetry(() => 
        this.client.GetOpenOrders({ symbol })
      );
    } catch (error) {
      this.logger?.log(`获取未成交订单失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 获取订单详情
   * @param {string} orderId - 订单ID
   * @returns {Promise<Object>} 订单详情
   */
  async getOrderDetails(orderId) {
    try {
      return await this.executeWithRetry(() => 
        this.client.GetOrder({ orderId })
      );
    } catch (error) {
      this.logger?.log(`获取订单详情失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 创建订单
   * @param {Object} params - 订单参数
   * @returns {Promise<Object>} 创建结果
   */
  async createOrder(params) {
    try {
      return await this.executeWithRetry(() => 
        this.client.ExecuteOrder(params)
      );
    } catch (error) {
      // 使用专门的API错误记录方法
      if (this.logger && typeof this.logger.logApiError === 'function') {
        this.logger.logApiError(error, "创建订单失败", params);
      } else {
        // 增强错误日志
        if (this.logger && typeof this.logger.log === 'function') {
          this.logger.log(`创建订单失败: ${error.message}`, true);
          
          // 记录详细的订单参数
          this.logger.log(`创建订单失败详情 - 参数: ${JSON.stringify(params)}`, true);
          
          // 记录错误对象的详细信息
          if (error.response) {
            this.logger.log(`错误响应状态: ${error.response.status}`, true);
            this.logger.log(`错误响应数据: ${JSON.stringify(error.response.data || {})}`, true);
          }
          
          // 记录原始错误对象
          this.logger.log(`原始错误: ${JSON.stringify(error.toString())}`, true);
          
          // 尝试解析更深层次的错误
          if (error.code) {
            this.logger.log(`错误代码: ${error.code}`, true);
          }
        } else {
          console.error(`创建订单失败: ${error.message}`);
          console.error(`参数: ${JSON.stringify(params)}`);
          if (error.response) {
            console.error(`响应: ${JSON.stringify(error.response)}`);
          }
        }
      }
      throw error;
    }
  }
  
  /**
   * 取消订单
   * @param {string} orderId - 订单ID
   * @returns {Promise<Object>} 取消结果
   */
  async cancelOrder(orderId) {
    try {
      return await this.executeWithRetry(() => 
        this.client.CancelOrder({ orderId })
      );
    } catch (error) {
      this.logger?.log(`取消订单失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 取消所有未成交订单
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 取消结果
   */
  async cancelAllOrders(symbol = this.symbol) {
    try {
      return await this.executeWithRetry(() => 
        this.client.CancelOpenOrders({ symbol })
      );
    } catch (error) {
      // 确保logger存在再使用
      if (this.logger && typeof this.logger.log === 'function') {
        this.logger.log(`取消所有订单失败: ${error.message}`);
      } else {
        // 使用全局log函数或console.log
        if (typeof log === 'function') {
          log(`取消所有订单失败: ${error.message}`);
        } else {
          console.log(`取消所有订单失败: ${error.message}`);
        }
      }
      throw error;
    }
  }
  
  /**
   * 创建买入订单
   * @param {number} price - 价格
   * @param {number} quantity - 数量
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 订单结果
   */
  async createBuyOrder(price, quantity, symbol = this.symbol) {
    const orderParams = {
      symbol,
      side: 'Bid', // 注意：必须使用'Bid'而不是'BUY'
      orderType: 'Limit', // 注意：必须使用'Limit'而不是'LIMIT'
      timeInForce: 'GTC',
      price: price.toString(),
      quantity: quantity.toString()
    };
    
    return this.createOrder(orderParams);
  }
  
  /**
   * 创建卖出订单
   * @param {number} price - 价格
   * @param {number} quantity - 数量
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 订单结果
   */
  async createSellOrder(price, quantity, symbol = this.symbol) {
    const orderParams = {
      symbol,
      side: 'Ask', // 注意：必须使用'Ask'而不是'SELL'
      orderType: 'Limit', // 注意：必须使用'Limit'而不是'LIMIT'
      timeInForce: 'GTC',
      price: price.toString(),
      quantity: quantity.toString()
    };
    
    return this.createOrder(orderParams);
  }
  
  /**
   * 获取持仓信息
   * @param {string} coin - 货币符号
   * @returns {Promise<Object>} 持仓信息
   */
  async getPosition(coin) {
    try {
      this.logger?.log(`正在获取${coin}持仓信息...`);
      const balances = await this.getBalances();
      
      this.logger?.log(`获取到余额数据: ${typeof balances}, 结构: ${Array.isArray(balances) ? '数组' : '对象'}`);
      if (balances) {
        this.logger?.log(`余额数据内容: ${JSON.stringify(balances)}`);
      }
      
      // 修复: 确保balances是数组，然后再使用find方法
      if (Array.isArray(balances)) {
        const position = balances.find(balance => balance.asset === coin);
        this.logger?.log(`查找${coin}结果: ${position ? JSON.stringify(position) : '未找到'}`);
        return position || { asset: coin, available: '0', total: '0' };
      } else if (balances && typeof balances === 'object') {
        // 如果balances是对象而非数组，尝试转换或直接查找
        if (balances[coin]) {
          this.logger?.log(`直接找到${coin}属性: ${JSON.stringify(balances[coin])}`);
          return { 
            asset: coin, 
            available: balances[coin].available || balances[coin].free || '0', 
            total: balances[coin].total || balances[coin].free || balances[coin].available || '0'
          };
        }
        
        // 尝试将对象转换为数组处理
        this.logger?.log(`尝试转换对象格式...`);
        const balancesArray = Object.keys(balances).map(key => ({
          asset: key,
          available: balances[key].available || balances[key].free || balances[key] || '0',
          total: balances[key].total || balances[key].free || balances[key] || '0'
        }));
        
        const position = balancesArray.find(balance => balance.asset === coin);
        this.logger?.log(`转换后查找${coin}结果: ${position ? JSON.stringify(position) : '未找到'}`);
        return position || { asset: coin, available: '0', total: '0' };
      }
      
      // 如果无法处理，返回空持仓
      this.logger?.log(`无法处理持仓数据，返回空持仓。balances类型: ${typeof balances}`, true);
      return { asset: coin, available: '0', total: '0' };
    } catch (error) {
      this.logger?.log(`获取持仓失败: ${error.message}`, true);
      // 出错时返回空持仓，而不是抛出异常
      return { asset: coin, available: '0', total: '0' };
    }
  }
  
  /**
   * 获取订单历史记录
   * @param {string} symbol - 交易对
   * @param {number} limit - 返回记录数量限制
   * @returns {Promise<Array>} 订单历史记录列表
   */
  async getOrderHistory(symbol = this.symbol, limit = 50) {
    try {
      this.logger?.log(`获取${symbol}订单历史记录...`);
      
      return await this.executeWithRetry(() => 
        this.client.OrderHistory({ 
          symbol, 
          limit
        })
      );
    } catch (error) {
      this.logger?.log(`获取订单历史记录失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 重置API请求状态
   * 在系统重启时调用，清理所有API相关的缓存和状态
   */
  resetRequestState() {
    try {
      // 记录开始重置API服务状态
      this.logger?.log('重置BackpackService API请求状态...');
      
      // 重新初始化官方BackpackClient
      try {
        // 重新创建客户端实例，确保状态清洁
        this.client = new BackpackClient(this.privateKey, this.publicKey);
        this.logger?.log('- BackpackClient已重新初始化');
      } catch (error) {
        this.logger?.log(`重新初始化BackpackClient失败: ${error.message}`, true);
      }
      
      // 清理可能的缓存数据
      this._cachedBalances = null;
      this._lastBalancesRequestTime = 0;
      this._cachedTicker = null;
      this._lastTickerRequestTime = 0;
      this._cachedOrderHistory = null;
      this._lastOrderHistoryRequestTime = 0;
      this.logger?.log('- API缓存数据已清除');
      
      // 重置API请求计数器
      this._requestCount = 0;
      this._requestErrors = 0;
      this._lastRequestTime = 0;
      this._retryCount = 0;
      this.logger?.log('- API请求计数器已重置');
      
      // 重置限流控制状态
      this._rateLimitResetTime = 0;
      this._rateLimitRemaining = null;
      this.logger?.log('- API限流控制状态已重置');
      
      this.logger?.log('BackpackService API请求状态重置完成');
      return true;
    } catch (error) {
      this.logger?.log(`重置API请求状态失败: ${error.message}`, true);
      return false;
    }
  }
}

module.exports = BackpackService; 